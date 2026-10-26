// Images and PDFs, for a model that sees: view_image puts an image before the
// model with the step's results, and read_pdf gives a PDF's text page by page,
// rendering the pages that have none — a scan, a drawing — as images to view.
// Both go through the workspace as the API does: inside it, never into .five/.

import * as crypto from "node:crypto";
import * as path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { extractText, getDocumentProxy, renderPageAsImage } from "unpdf";
import { Workspace, WorkspaceError } from "../api/workspace.ts";
import type { ToolDef } from "../llm/model.ts";

/** Where five keeps what it makes for the model to see: shrunk images, rendered pages. */
export const IMAGES_DIR = "results/images";

/** What view_image reads; canvas decodes these. */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** Pages read_pdf renders in one call, at most. */
const MAX_RENDERED = 8;

export interface MediaEnv {
  workspace: string;
  /** The longest side an image is shrunk to before the model sees it. */
  imageSide: number;
  /** Shows the model this workspace image after the step's results. */
  attachImage(rel: string): void;
}

export interface MediaTool extends ToolDef {
  run(args: Record<string, unknown>, env: MediaEnv): Promise<string>;
}

/**
 * An image as the model will see it: decoded, shrunk to fit side × side,
 * flattened on white and kept as a JPEG in IMAGES_DIR, named by its content.
 */
export async function prepareImage(
  workspace: string,
  rel: string,
  side: number,
): Promise<{ path: string; width: number; height: number; original: { width: number; height: number } }> {
  const ws = new Workspace(workspace);
  const { entry, bytes } = ws.read(rel);
  let img: Awaited<ReturnType<typeof loadImage>>;
  try {
    img = await loadImage(bytes);
  } catch {
    throw new WorkspaceError(400, `${entry.path} is not an image five can read (png, jpeg, gif, webp, bmp)`);
  }
  const scale = Math.min(1, side / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(width, height);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.drawImage(img, 0, 0, width, height);
  const jpeg = await canvas.encode("jpeg", 85);
  const hash = crypto.createHash("sha1").update(bytes).update(String(side)).digest("hex").slice(0, 8);
  const name = path.basename(entry.path).replace(/\.[^.]*$/, "");
  const out = `${IMAGES_DIR}/${name}-${hash}.jpg`;
  ws.write(out, jpeg);
  return { path: out, width, height, original: { width: img.width, height: img.height } };
}

/** A workspace image as base64, for a model call; undefined when it is gone. */
export function imageData(workspace: string, rel: string): string | undefined {
  try {
    return new Workspace(workspace).read(rel).bytes.toString("base64");
  } catch {
    return undefined;
  }
}

/** A PDF's text from page first to last; a page without text is rendered as a PNG to view instead. */
export async function readPdf(workspace: string, rel: string, first?: number, last?: number): Promise<string> {
  const ws = new Workspace(workspace);
  const { entry, bytes } = ws.read(rel);
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    doc = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    throw new WorkspaceError(400, `${entry.path} is not a PDF five can read`);
  }
  const { totalPages, text } = await extractText(doc, { mergePages: false });
  const from = Math.max(1, Math.min(first ?? 1, totalPages));
  const to = Math.max(from, Math.min(last ?? totalPages, totalPages));
  const name = path.basename(entry.path).replace(/\.[^.]*$/, "");
  const parts = [`${entry.path}: ${totalPages} page${totalPages === 1 ? "" : "s"}; pages ${from}–${to} follow.`];
  let rendered = 0;
  for (let n = from; n <= to; n++) {
    const t = (text[n - 1] ?? "").trim();
    if (t) {
      parts.push(`--- page ${n} ---\n${t}`);
      continue;
    }
    if (rendered >= MAX_RENDERED) {
      parts.push(
        `--- page ${n} --- no text, and not rendered: read_pdf renders ${MAX_RENDERED} pages a call; ask for it again.`,
      );
      continue;
    }
    const png = await renderPageAsImage(doc, n, { canvasImport: () => import("@napi-rs/canvas"), scale: 2 });
    const out = `${IMAGES_DIR}/${name}-p${n}.png`;
    ws.write(out, Buffer.from(png));
    rendered++;
    parts.push(`--- page ${n} --- no text (a scan, or a drawing): rendered as ${out}; view_image it to see the page.`);
  }
  return parts.join("\n\n");
}

export const mediaTools: MediaTool[] = [
  {
    name: "view_image",
    description:
      "Look at an image in the workspace (png, jpeg, gif, webp, bmp). It is shrunk to fit, kept in results/images/, " +
      "and shown to you right after this step's results; then say what you see or do what you need with it. An " +
      "image costs context like text does — end_turn's summary drops it with the rest of the turn.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "The image's path, relative to the workspace." } },
      required: ["path"],
    },
    async run(a, env) {
      const rel = String(a.path ?? "").trim();
      if (!rel) return "error: give the image's path";
      try {
        const img = await prepareImage(env.workspace, rel, env.imageSide);
        env.attachImage(img.path);
        const shrunk =
          img.width === img.original.width && img.height === img.original.height
            ? ""
            : `, shrunk from ${img.original.width}×${img.original.height}`;
        return `attached ${img.path} (${img.width}×${img.height}${shrunk}): it follows this step's results.`;
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    name: "read_pdf",
    description:
      "Read a PDF in the workspace: its text, page by page. A page without text — a scan, a drawing — is rendered " +
      "as an image in results/images/ for view_image. A long result is kept whole in results/, as for any tool.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The PDF's path, relative to the workspace." },
        first: { type: "number", description: "The first page to read (from 1). Default: 1." },
        last: { type: "number", description: "The last page to read. Default: the last." },
      },
      required: ["path"],
    },
    async run(a, env) {
      const rel = String(a.path ?? "").trim();
      if (!rel) return "error: give the PDF's path";
      const page = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
      try {
        return await readPdf(env.workspace, rel, page(a.first), page(a.last));
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];

export const mediaToolsByName = new Map(mediaTools.map((t) => [t.name, t]));
