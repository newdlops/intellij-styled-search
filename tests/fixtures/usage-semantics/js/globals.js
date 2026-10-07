function exposed() {
  return 1;
}
var assigned = function internalAssigned() {
  return 2;
};
function outer() {
  function privateHelper() {
    return 3;
  }
  return privateHelper();
}
