export function transform(value) { return value; }
transform(1);
function objectParameter({ value: { transform }, callback: alias, ...rest }) {
  return transform(alias, rest);
}
function arrayParameter([, { transform }, ...rest]) {
  return transform(rest);
}
function defaults({ callback = transform(2) } = {}) {
  return callback;
}
const closure = transform => next => transform(next);
function localPattern(source) {
  const { callback: transform } = source;
  return transform();
}
function localValue() {
  var transform = 0;
  return transform;
}
function localCallable() {
  function transform(value) { return value + 1; }
  return transform(3);
}
const selected = { transform };
function listBindings() {
  var $node,
    transform = function (value) { return value; },
    other;
  return () => transform($node);
}
function caught() {
  try { throw 1; } catch ({ transform }) {
    var retained = transform;
    return () => transform();
  }
  return retained;
}
export function $apply(value) { return value; }
$apply(4);
