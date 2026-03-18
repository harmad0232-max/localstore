import fs from "fs";
import fsp from "fs/promises";
import path from "path";

function joinRoot(root, rel) {
  const p = rel ? path.normalize(rel) : "";
  const safe = p.replace(/^(\.\.(\/|\\|$))+/g, "");
  return path.join(root, safe);
}

export class LocalProvider {
  constructor(options) {
    this.root = options?.root || process.cwd();
  }
  async list(dir) {
    const abs = joinRoot(this.root, dir);
    const names = await fsp.readdir(abs, { withFileTypes: true });
    const items = await Promise.all(
      names.map(async (d) => {
        const p = path.join(abs, d.name);
        const st = await fsp.stat(p);
        return {
          name: d.name,
          type: d.isDirectory() ? "dir" : "file",
          size: st.size,
          mtime: st.mtimeMs
        };
      })
    );
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  }
  async ensureDir(dir) {
    const abs = joinRoot(this.root, dir);
    await fsp.mkdir(abs, { recursive: true });
  }
  async put(filePath, buffer) {
    const relDir = path.dirname(filePath);
    await this.ensureDir(relDir);
    const abs = joinRoot(this.root, filePath);
    await fsp.writeFile(abs, buffer);
  }
  async putFile(filePath, localTempPath) {
    const relDir = path.dirname(filePath);
    await this.ensureDir(relDir);
    const abs = joinRoot(this.root, filePath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.copyFile(localTempPath, abs);
  }
  async remove(p) {
    const abs = joinRoot(this.root, p);
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      await fsp.rm(abs, { recursive: true, force: true });
    } else {
      await fsp.unlink(abs);
    }
  }
  async move(from, to) {
    const absFrom = joinRoot(this.root, from);
    const absTo = joinRoot(this.root, to);
    await fsp.mkdir(path.dirname(absTo), { recursive: true });
    await fsp.rename(absFrom, absTo);
  }
  async read(p) {
    const abs = joinRoot(this.root, p);
    return await fsp.readFile(abs);
  }
  async exists(p) {
    try {
      const abs = joinRoot(this.root, p);
      await fsp.access(abs);
      return true;
    } catch {
      return false;
    }
  }
}
