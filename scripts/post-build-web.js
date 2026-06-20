import fs from "fs"
import path from "path"

const srcHtml = path.resolve("web-dist/src/entrypoints/options/index.html")
const destHtml = path.resolve("web-dist/index.html")

if (fs.existsSync(srcHtml)) {
  fs.copyFileSync(srcHtml, destHtml)
  console.log("Successfully copied index.html to web-dist/index.html")
} else {
  console.error("Error: Source HTML file not found at", srcHtml)
  process.exit(1)
}
