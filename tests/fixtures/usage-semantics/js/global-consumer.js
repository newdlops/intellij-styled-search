exposed();
window.exposed();
window.assigned();
function parameter(exposed) {
  return exposed();
}
const arrow = (assigned) => assigned();
