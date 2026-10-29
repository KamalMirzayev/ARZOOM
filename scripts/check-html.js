// CI check: each page's inline script must parse.
const fs = require("fs");
for (const f of ["public/index.html", "site/public/index.html", "site/public/404.html", "site/public/mexfilik.html", "site/public/sertler.html"]) {
  const html = fs.readFileSync(__dirname + "/../" + f, "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n;\n");
  new Function(js);
  console.log(f + ": script OK");
}
