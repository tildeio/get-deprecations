import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import { CallExpression, IfStatement, isIdentifier } from "@babel/types";
import generate from "@babel/generator";
import fs from "node:fs";
import { NodePath } from "@babel/traverse";
import { globSync } from "glob";

interface Entry {
  filename: string;
  line: number | undefined;
  id: string;
  code: string;
  debug: boolean;
}

function processFile(filename: string): Entry[] {
  let entries: Entry[] = [];

  const code = fs.readFileSync(filename, { encoding: "utf-8" });

  const ast = parser.parse(code, {
    sourceType: "module",
    plugins: ["typescript", "decorators-legacy"],
  });

  let isInsideDebugBlock = 0;

  function isDebugIfStatement(path: NodePath<IfStatement>): boolean {
    let found = false;

    if (
      path.node.test.type === "Identifier" &&
      path.node.test.name === "DEBUG"
    ) {
      found = true;
    } else {
      traverse(
        path.node.test,
        {
          Identifier(path) {
            if (path.node.name === "DEBUG") {
              found = true;
            }
          },
        },
        path.scope,
        path.state,
        path
      );
    }

    return found;
  }

  function findDeprecationId(path: NodePath<CallExpression>): string {
    let id = "???";

    traverse(
      path.node,
      {
        ObjectProperty(path) {
          if (isIdentifier(path.node.key, { name: "id" })) {
            if (path.node.value.type === "StringLiteral") {
              id = path.node.value.value;
            } else {
              id = "???";
            }
          }
        },
      },
      path.scope,
      path.state,
      path
    );

    return id;
  }

  traverse(ast, {
    IfStatement: {
      enter(path) {
        if (isDebugIfStatement(path)) {
          isInsideDebugBlock++;
        }
      },
      exit(path) {
        if (isDebugIfStatement(path)) {
          isInsideDebugBlock--;
        }
      },
    },
    CallExpression(path) {
      if (isIdentifier(path.node.callee, { name: "deprecate" })) {
        entries.push({
          filename: filename.split("../ember.js/packages/")[1]!,
          line: path.node.loc?.start.line,
          id: findDeprecationId(path),
          code: generate(path.node).code,
          debug: isInsideDebugBlock > 0,
        });
      }
    },
  });

  if (isInsideDebugBlock !== 0) {
    throw new Error(`isInsideDebugBlock is ${isInsideDebugBlock}`);
  }

  return entries;
}

let entries: Entry[] = [];

for (let path of globSync("../ember.js/packages/**/*.{ts,js}", {
  nodir: true,
  ignore: {
    ignored(path) {
      if (path.name.endsWith(".d.ts")) {
        return true;
      }

      if (path.name.includes("test")) {
        return true;
      }

      return false;
    },
  },
})) {
  try {
    entries.push(...processFile(path));
  } catch (e) {
    console.error(path);
    console.error(e);
    process.exit(1);
  }
}

function formatReport(entries: Entry[]): void {
  let report = "";

  let grouped = new Map<string, Entry[]>();

  for (let entry of entries) {
    grouped.set(entry.id, [...(grouped.get(entry.id) ?? []), entry]);
  }

  for (let id of [...grouped.keys()].sort()) {
    let printTitle = () => {
      report += `# ${id}\n\n`;
      printTitle = () => {};
    };

    for (let entry of grouped.get(id) ?? []) {
      if (!entry.debug) {
        continue;
      }

      printTitle();

      report += `## \`${entry.filename}:${entry.line}\`\n\n`;

      report += `https://github.com/emberjs/ember.js/blob/lts-3-28/packages/${encodeURIComponent(
        entry.filename
      )}#L${entry.line}\n\n`;

      report += "```ts\n";
      report += entry.code;
      report += "\n```\n\n";
    }
  }

  fs.writeFileSync("report.md", report, { encoding: "utf-8" });
}

formatReport(entries);
