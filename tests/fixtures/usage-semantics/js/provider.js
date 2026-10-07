var Factory = function internalFactory(value) {
  return value;
};
export default Factory;
export function execute() {
  return 1;
}
export function count() {
  return 2;
}
const table = {
  count: count,
};
function shadow() {
  var count = 0;
  return count;
}
export { table, shadow };
