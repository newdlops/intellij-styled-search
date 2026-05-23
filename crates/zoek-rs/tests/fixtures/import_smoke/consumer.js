"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.consumeImports = consumeImports;
const api_1 = require("./api");
function consumeImports() {
    const item = new api_1.ImportedWidget();
    (0, api_1.importedUtility)();
    return item;
}
//# sourceMappingURL=consumer.js.map