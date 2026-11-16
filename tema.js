// Tema de la versión de escritorio (claro u oscuro). Va en el <head> para aplicarlo antes de pintar.
// En el celular no cambia nada: los colores claros sólo se definen en escritorio.css (desde 1024 px).
(function () {
  var t = 'claro';
  try { var g = localStorage.getItem('fin_tema'); if (g === 'oscuro' || g === 'claro') t = g; } catch (e) {}
  document.documentElement.setAttribute('data-tema', t);
})();
