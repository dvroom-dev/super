import type { ForkPatch, ForkPatchOp } from "./types.js";

function splitLines(text: string): string[] {
  if (text === "") return [""];
  return text.split(/\r?\n/);
}

function mergeOps(ops: Array<{ op: ForkPatchOp["op"]; line: string }>): ForkPatch {
  const merged: ForkPatchOp[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (!last || last.op !== op.op) {
      merged.push({ op: op.op, lines: [op.line] });
    } else {
      last.lines.push(op.line);
    }
  }
  return { ops: merged.filter((o) => o.lines.length > 0) };
}

export function diffLines(baseText: string, nextText: string): ForkPatch {
  const a = splitLines(baseText);
  const b = splitLines(nextText);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  let v = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const ops: Array<{ op: ForkPatchOp["op"]; line: string }> = [];
        let curX = n;
        let curY = m;
        for (let d2 = trace.length - 1; d2 >= 0; d2 -= 1) {
          const v2 = trace[d2];
          const k2 = curX - curY;
          let prevK: number;
          if (k2 === -d2 || (k2 !== d2 && v2[offset + k2 - 1] < v2[offset + k2 + 1])) {
            prevK = k2 + 1;
          } else {
            prevK = k2 - 1;
          }
          const prevX = v2[offset + prevK];
          const prevY = prevX - prevK;
          while (curX > prevX && curY > prevY) {
            ops.push({ op: "equal", line: a[curX - 1] });
            curX -= 1;
            curY -= 1;
          }
          if (d2 === 0) break;
          if (curX === prevX) {
            ops.push({ op: "insert", line: b[curY - 1] });
            curY -= 1;
          } else {
            ops.push({ op: "delete", line: a[curX - 1] });
            curX -= 1;
          }
        }
        ops.reverse();
        return mergeOps(ops);
      }
    }
  }

  return mergeOps([
    { op: "delete", line: baseText },
    { op: "insert", line: nextText },
  ]);
}

export function applyPatch(baseText: string, patch: ForkPatch): string {
  const baseLines = splitLines(baseText);
  let idx = 0;
  const out: string[] = [];

  for (const op of patch.ops) {
    const lines = op.lines || [];
    if (op.op === "equal") {
      for (const line of lines) {
        if (baseLines[idx] !== line) {
          throw new Error("patch mismatch: equal segment does not match base");
        }
        out.push(line);
        idx += 1;
      }
      continue;
    }
    if (op.op === "delete") {
      for (const line of lines) {
        if (baseLines[idx] !== line) {
          throw new Error("patch mismatch: delete segment does not match base");
        }
        idx += 1;
      }
      continue;
    }
    if (op.op === "insert") {
      for (const line of lines) {
        out.push(line);
      }
      continue;
    }
  }

  if (idx !== baseLines.length) {
    throw new Error("patch mismatch: base length mismatch");
  }

  return out.join("\n");
}
