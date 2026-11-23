import { exec } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Konversi DXF → DWG memakai konverter eksternal, karena format DWG bersifat proprietary.
 * Atur di .env, mis. dengan ODA File Converter (gratis):
 *   DWG_CONVERTER_COMMAND="\"C:\\Program Files\\ODA\\ODAFileConverter\\ODAFileConverter.exe\" \"{indir}\" \"{outdir}\" ACAD2018 DWG 0 1"
 * Placeholder yang didukung: {indir} folder berisi DXF input, {outdir} folder output,
 * {input} path file DXF, {output} path file DWG yang diharapkan.
 */
export function dwgConfigured(): boolean {
  return Boolean(process.env.DWG_CONVERTER_COMMAND?.trim());
}

const quote = (p: string) => `"${p.replace(/"/g, '\\"')}"`;

export async function convertDxfToDwg(dxf: string, baseName: string): Promise<Buffer> {
  const template = process.env.DWG_CONVERTER_COMMAND?.trim();
  if (!template) throw new Error("DWG_CONVERTER_COMMAND belum dikonfigurasi.");

  const dir = await mkdtemp(path.join(tmpdir(), "topokontur-"));
  try {
    const inDir = path.join(dir, "in");
    const outDir = path.join(dir, "out");
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });

    const inputPath = path.join(inDir, `${baseName}.dxf`);
    const outputPath = path.join(outDir, `${baseName}.dwg`);
    await writeFile(inputPath, dxf, "utf8");

    const cmd = template
      .replaceAll("{indir}", quote(inDir))
      .replaceAll("{outdir}", quote(outDir))
      .replaceAll("{input}", quote(inputPath))
      .replaceAll("{output}", quote(outputPath));

    try {
      await execAsync(cmd, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Konverter DWG gagal dijalankan: ${msg.split("\n")[0]}`);
    }

    try {
      return await readFile(outputPath);
    } catch {
      const files = await readdir(outDir);
      const dwg = files.find((f) => f.toLowerCase().endsWith(".dwg"));
      if (!dwg) throw new Error("Konverter tidak menghasilkan file DWG.");
      return await readFile(path.join(outDir, dwg));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
