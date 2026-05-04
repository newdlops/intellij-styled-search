"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportedValue = exports.ExportedMode = exports.ExportedClass = void 0;
exports.exportedLower = exportedLower;
exports.exportedLowerAgain = exportedLower;
function exportedLower() {
    return exports.exportedValue;
}
class ExportedClass {
}
exports.ExportedClass = ExportedClass;
var ExportedMode;
(function (ExportedMode) {
    ExportedMode["Ready"] = "ready";
})(ExportedMode || (exports.ExportedMode = ExportedMode = {}));
exports.exportedValue = 3;
//# sourceMappingURL=callgraph_external_api.js.map