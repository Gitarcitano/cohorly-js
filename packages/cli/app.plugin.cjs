// Expo config plugin entry: `"plugins": ["@cohorly/cli"]` in app.json.
// CommonJS, because Expo loads it with require() (Node 20, or Node 22 before
// 22.12, cannot require ESM). dist/cjs is a CommonJS build of src/expo.ts.
const plugin = require("./dist/cjs/expo.js");

module.exports = Object.assign(plugin.default, plugin);
