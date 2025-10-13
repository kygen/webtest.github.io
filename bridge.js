(function (global) {
  const REQUEST = 'REQUEST';
  const RESPONSE = 'RESPONSE';
  const ACTIONS = new Set(['Init', 'ShowAd', 'Purchase', 'CheckProduct', 'RestorePurchases']);
  const AD_TYPES = new Set(['interstitial', 'rewarded', 'banner']);

  const callbacks = new Map();
  const listeners = new Set();
  const queue = [];
  const pendingActions = new Set();
  let activeRequestId = null;
  let adWindow = [];

  function now() { return Date.now(); }

  function hasBridge() {
    return global.AndroidBridge && typeof global.AndroidBridge.postMessage === 'function';
  }

  function generateRequestId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return `${now()}-${Math.random().toString(16).slice(2)}`;
  }

  function notify(type, detail) {
    listeners.forEach((fn) => {
      try { fn(type, detail); } catch (err) { console.error('[Bridge] listener error', err); }
    });
  }

  function cleanAdWindow(timestamp) {
    adWindow = adWindow.filter((t) => timestamp - t < 10000);
  }

  function reserveAdSlot() {
    const timestamp = now();
    cleanAdWindow(timestamp);
    if (adWindow.length >= 2) {
      throw new Error('تم تجاوز حد طلبات الإعلانات (2 خلال 10 ثوانٍ).');
    }
    return timestamp;
  }

  function commitAdSlot(timestamp) {
    if (typeof timestamp === 'number') {
      adWindow.push(timestamp);
    }
  }

  function releaseAdSlot(timestamp) {
    if (typeof timestamp !== 'number') {
      return;
    }
    const index = adWindow.indexOf(timestamp);
    if (index !== -1) {
      adWindow.splice(index, 1);
    }
  }

  function validate(action, payload) {
    if (!ACTIONS.has(action)) {
      throw new Error('Action غير مدعومة: ' + action);
    }

    if (pendingActions.has(action)) {
      throw new Error('لا يزال هناك طلب قيد التنفيذ لنفس النوع.');
    }

    if (action === 'ShowAd') {
      const adType = payload && payload.adType;
      if (!AD_TYPES.has(adType)) {
        throw new Error('قيمة adType غير صالحة.');
      }
    }

    if (action === 'Purchase' || action === 'CheckProduct') {
      if (!payload || typeof payload.productId !== 'string' || payload.productId.trim() === '') {
        throw new Error('productId مطلوب.');
      }
    }
  }

  function drainQueue() {
    if (activeRequestId || queue.length === 0) {
      return;
    }

    if (!hasBridge()) {
      notify('bridge:unavailable', null);
      return;
    }

    const entry = queue.shift();
    activeRequestId = entry.requestId;

    try {
      commitAdSlot(entry.adTimestamp);
      notify('request:sent', { action: entry.action, requestId: entry.requestId, payload: entry.payload });
      global.AndroidBridge.postMessage(JSON.stringify(entry.message));
    } catch (error) {
      console.error('[Bridge] postMessage failed', error);
      activeRequestId = null;
      releaseAdSlot(entry.adTimestamp);
      pendingActions.delete(entry.action);
      callbacks.delete(entry.requestId);
      entry.reject(error);
      notify('request:error', {
        action: entry.action,
        requestId: entry.requestId,
        error: {
          code: error.code || 'POST_MESSAGE_FAILED',
          message: error.message || 'postMessage failed'
        }
      });
      setTimeout(drainQueue, 0);
    }
  }

  function sendRequest(action, payload = {}) {
    return new Promise((resolve, reject) => {
      let adTimestamp = null;

      try {
        validate(action, payload);
        if (action === 'ShowAd') {
          adTimestamp = reserveAdSlot();
        }
      } catch (validationError) {
        notify('request:rejected', {
          action,
          payload,
          reason: validationError.message,
          error: {
            code: 'VALIDATION_FAILED',
            message: validationError.message
          }
        });
        notify('request:error', {
          action,
          requestId: null,
          error: {
            code: 'VALIDATION_FAILED',
            message: validationError.message
          }
        });
        reject(validationError);
        return;
      }

      if (!hasBridge()) {
        const err = new Error('الجسر متاح فقط داخل التطبيق.');
        notify('bridge:unavailable', null);
        notify('request:error', {
          action,
          requestId: null,
          error: {
            code: 'BRIDGE_UNAVAILABLE',
            message: err.message
          }
        });
        reject(err);
        releaseAdSlot(adTimestamp);
        return;
      }

      const requestId = generateRequestId();
      const message = {
        type: REQUEST,
        action,
        requestId,
        payload
      };

      const entry = { requestId, action, payload, resolve, reject, message, adTimestamp };
      callbacks.set(requestId, entry);
      pendingActions.add(action);
      queue.push(entry);
      drainQueue();
    });
  }

  function handleResponse(data) {
    const requestId = data.requestId;
    if (!requestId) {
      return;
    }

    const entry = callbacks.get(requestId);
    if (!entry) {
      notify('response:orphan', data);
      return;
    }

    notify('response:received', data);

    if (data.status === 'PENDING') {
      return;
    }

    callbacks.delete(requestId);
    pendingActions.delete(entry.action);

    if (activeRequestId === requestId) {
      activeRequestId = null;
    }

    if (data.status === 'SUCCESS') {
      const payload = data.payload || {};
      notify('request:success', {
        action: entry.action,
        requestId,
        payload
      });
      entry.resolve({
        requestId,
        action: entry.action,
        status: data.status,
        payload
      });
    } else {
      const errorInfo = data.error || {};
      const err = new Error(errorInfo.message || 'حدث خطأ أثناء التنفيذ');
      err.code = errorInfo.code || 'UNKNOWN';
      err.payload = data.payload || {};
      err.requestId = requestId;
      err.action = entry.action;
      notify('request:error', {
        action: entry.action,
        requestId,
        error: {
          code: err.code,
          message: err.message
        },
        payload: err.payload
      });
      entry.reject(err);
    }

    notify('request:completed', {
      action: entry.action,
      requestId,
      status: data.status
    });

    setTimeout(drainQueue, 0);
  }

  function onNativeMessage(jsonString) {
    notify('response:raw', { raw: jsonString });
    if (typeof jsonString !== 'string' || jsonString.length === 0) {
      return;
    }

    let data;
    try {
      data = JSON.parse(jsonString);
    } catch (error) {
      console.warn('[Bridge] فشل تحويل JSON', error);
      notify('response:error', { error });
      return;
    }

    if (data.type !== RESPONSE) {
      return;
    }

    handleResponse(data);
  }

  function subscribe(listener) {
    if (typeof listener === 'function') {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    return () => {};
  }

  global.WebBridge = {
    sendRequest,
    onNativeMessage,
    subscribe,
    isAvailable: hasBridge,
    makeRequestId: generateRequestId
  };

  global.onNativeMessage = onNativeMessage;

  global.addEventListener('focus', () => {
    if (hasBridge()) {
      notify('bridge:available', null);
      drainQueue();
    }
  });
})(window);
