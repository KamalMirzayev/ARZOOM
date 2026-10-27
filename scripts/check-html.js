// CI check: the page's inline script must parse.
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/../public/index.html", "utf8");
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n;\n");
new Function(js);
console.log("index.html: script OK");
