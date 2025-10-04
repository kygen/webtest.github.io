// يوفر واجهة موحدة من الويب إلى أندرويد عبر window.AndroidBridge
// وفي المتصفح العادي يطبع فقط (للاختبار).
(function(){
  function call(name, ...args) {
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge[name] === 'function') {
        return window.AndroidBridge[name].apply(window.AndroidBridge, args);
      }
      console.log('[Bridge:fallback]', name, args);
    } catch (e) { console.log('[Bridge:error]', e); }
  }
  window.App = {
    ping: () => call('ping'),
    purchase: (sku) => call('purchase', String(sku||'')),
    showAd: (placement) => call('showAd', String(placement||'')),
    setConsent: (json) => call('setConsentJson', String(json||'')),
  };
})();
