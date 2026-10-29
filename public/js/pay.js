(function () {
  'use strict';
  var el = document.getElementById('pay-config');
  if (!el || !window.Moyasar) {
    var box = document.querySelector('.mysr-form');
    if (box) box.innerHTML = '<p class="form-error">تعذّر تحميل بوابة الدفع. تحقق من الاتصال وأعد تحميل الصفحة، أو اختر التحويل البنكي.</p>';
    return;
  }
  var c = JSON.parse(el.textContent);
  var opts = {
    element: '.mysr-form',
    amount: c.amount,
    currency: c.currency,
    description: c.description,
    publishable_api_key: c.publishableKey,
    callback_url: c.callbackUrl,
    methods: c.methods,
    language: 'ar',
    metadata: c.metadata
  };
  if (c.methods.indexOf('applepay') !== -1) {
    opts.apple_pay = { country: 'SA', label: c.applePayLabel, validate_merchant_url: 'https://api.moyasar.com/v1/applepay/initiate' };
  }
  window.Moyasar.init(opts);
})();
