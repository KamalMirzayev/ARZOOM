// CI check: each page's inline script must parse.
const fs = require("fs");
for (const f of ["public/index.html", "site/public/index.html"]) {
  const html = fs.readFileSync(__dirname + "/../" + f, "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n;\n");
  new Function(js);
  console.log(f + ": script OK");
}
