// stats of "org" ASN occurrences in test_result JSON files

"use strict";

const fs = require("fs");
const path = require("path");

const baseDir = process.argv[2] || "./test_results";
const outputPath = process.argv[3] || "./test_results/as-org-frequency-stats-result.tsv";
let entries;
try {
  entries = fs.readdirSync(baseDir, { withFileTypes: true });
} catch (err) {
  console.error(`Failed to read directory: ${baseDir}`);
  process.exitCode = 1;
  process.exit();
}

const jsonFiles = entries
  .filter((ent) => ent.isFile() && ent.name.endsWith(".json"))
  .map((ent) => path.join(baseDir, ent.name));

const counts = new Map();

function bump(org) {
  counts.set(org, (counts.get(org) || 0) + 1);
}

function walk(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "org" && typeof value === "string") {
        bump(value);
      } else {
        walk(value);
      }
    }
  }
}

for (const filePath of jsonFiles) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    continue;
  }
  if (data && typeof data === "object" && data.domainDetails !== undefined) {
    walk(data.domainDetails);
  }
}

const rows = Array.from(counts.entries()).sort((a, b) => {
  if (b[1] !== a[1]) return b[1] - a[1];
  return a[0].localeCompare(b[0]);
});

const lines = [
  "asn\torg_name\tcount",
  ...rows.map(([org, count]) => {
    const match = org.match(/^(AS\d+)\s+(.*)$/);
    if (match) {
      return `${match[1]}\t${match[2]}\t${count}`;
    }
    return `\t${org}\t${count}`;
  }),
];
try {
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
} catch (err) {
  console.error(`Failed to write output: ${outputPath}`);
  process.exitCode = 1;
  process.exit();
}
