(function (global) {
  const REQUEST = 'REQUEST';
  const RESPONSE = 'RESPONSE';
  const EVENT = 'EVENT';
  const ACTIONS = new Set(['Init', 'ShowAd', 'Purchase', 'CheckProduct', 'RestorePurchases', 'CheckAdAvailability']);
  const AD_TYPES = new Set(['interstitial', 'rewarded', 'banner', 'app_open', 'appopen', 'rewarded_interstitial', 'rewardedinterstitial']);

  const callbacks = new Map();
  const listeners = new Set();
  const queue = [];
  const pendingExclusive = new Map();
  const adWindow = [];
  let activeRequestId = null;

  function now() {
    return Date.now();
  }

  function hasBridge() {
    return global.AndroidBridge && typeof global.AndroidBridge.postMessage === 'function';
  }

  function generateRequestId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return `${now()}-${Math.random().toString(16).slice(2)}`;
  }

  function isExclusive(action) {
    switch (action) {
      case 'Init':
      case 'ShowAd':
      case 'Purchase':
      case 'RestorePurchases':
        return true;
      default:
        return false;
    }
  }

  function notify(type, detail) {
    listeners.forEach((fn) => {
      try {
        fn(type, detail);
      } catch (err) {
        console.error('[Bridge] listener error', err);
      }
    });
  }

  function cleanAdWindow(timestamp) {
    adWindow.splice(0, adWindow.length, ...adWindow.filter((t) => timestamp - t < 10000));
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

    if (isExclusive(action) && pendingExclusive.has(action)) {
      throw new Error('لا يزال هناك طلب قيد التنفيذ لنفس النوع.');
    }

    if (action === 'ShowAd' || action === 'CheckAdAvailability') {
      const adType = payload && payload.adType;
      if (!AD_TYPES.has((adType || '').toLowerCase())) {
        throw new Error('قيمة adType غير صالحة.');
      }
    }

    if ((action === 'Purchase' || action === 'CheckProduct') && (!payload || typeof payload.productId !== 'string' || payload.productId.trim() === '')) {
      throw new Error('productId مطلوب.');
    }
  }

  function completeExclusive(action) {
    if (!isExclusive(action)) {
      return;
    }

    const current = pendingExclusive.get(action) || 0;
    if (current <= 1) {
      pendingExclusive.delete(action);
    } else {
      pendingExclusive.set(action, current - 1);
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
      completeExclusive(entry.action);
      callbacks.delete(entry.requestId);
      entry.reject(error);
      notify('request:error', { action: entry.action, requestId: entry.requestId, error });
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
        notify('request:rejected', { action, payload, reason: validationError.message });
        reject(validationError);
        return;
      }

      if (!hasBridge()) {
        const err = new Error('الجسر متاح فقط داخل التطبيق.');
        notify('bridge:unavailable', null);
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

      if (isExclusive(action)) {
        pendingExclusive.set(action, (pendingExclusive.get(action) || 0) + 1);
      }

      const entry = { requestId, action, payload, resolve, reject, message, adTimestamp };
      callbacks.set(requestId, entry);
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
    completeExclusive(entry.action);

    if (activeRequestId === requestId) {
      activeRequestId = null;
    }

    if (data.status === 'SUCCESS') {
      entry.resolve({
        requestId,
        action: entry.action,
        status: data.status,
        payload: data.payload || {}
      });
    } else {
      const errorInfo = data.error || {};
      const err = new Error(errorInfo.message || 'حدث خطأ أثناء التنفيذ');
      err.code = errorInfo.code || 'UNKNOWN';
      err.payload = data.payload || {};
      err.requestId = requestId;
      err.action = entry.action;
      entry.reject(err);
    }

    releaseAdSlot(entry.adTimestamp);
    setTimeout(drainQueue, 0);
  }

  function handleEvent(data) {
    notify('event:received', data);
    if (!data || typeof data.event !== 'string') {
      return;
    }

    switch (data.event) {
      case 'AdAvailabilityChanged':
        notify('event:adAvailability', data.payload || {});
        break;
      default:
        break;
    }
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

    if (data.type === RESPONSE) {
      handleResponse(data);
    } else if (data.type === EVENT) {
      handleEvent(data);
    }
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
