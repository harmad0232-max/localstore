export class AzureProvider {
  constructor(options) {
    this.options = options || {};
  }
  async list() {
    throw new Error("Azure provider not configured");
  }
  async ensureDir() {
    throw new Error("Azure provider not configured");
  }
  async put() {
    throw new Error("Azure provider not configured");
  }
  async remove() {
    throw new Error("Azure provider not configured");
  }
  async move() {
    throw new Error("Azure provider not configured");
  }
  async read() {
    throw new Error("Azure provider not configured");
  }
  async exists() {
    throw new Error("Azure provider not configured");
  }
}
