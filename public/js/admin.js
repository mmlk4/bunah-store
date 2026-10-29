(function () {
  'use strict';
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) { if (!confirm(f.getAttribute('data-confirm'))) e.preventDefault(); });
  });
  var flash = document.querySelector('.flash');
  if (flash) {
    setTimeout(function () { flash.style.opacity = '0'; }, 4000);
    try { var u = new URL(location.href); u.searchParams.delete('msg'); history.replaceState(null, '', u); } catch (e) {}
  }
})();
