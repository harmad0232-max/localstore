import { LocalProvider } from "./local.js";
import { AzureProvider } from "./azure.js";
import { AwsS3Provider } from "./aws.js";

export function createProvider(kind, options) {
  if (kind === "local") return new LocalProvider(options);
  if (kind === "azure") return new AzureProvider(options);
  if (kind === "aws") return new AwsS3Provider(options);
  throw new Error("Unsupported provider");
}

export class Provider {
  async list(dir) {
    throw new Error("not implemented");
  }
  async ensureDir(dir) {
    throw new Error("not implemented");
  }
  async put(filePath, buffer) {
    throw new Error("not implemented");
  }
  async putFile(filePath, localTempPath) {
    throw new Error("not implemented");
  }
  async remove(p) {
    throw new Error("not implemented");
  }
  async move(from, to) {
    throw new Error("not implemented");
  }
  async read(p) {
    throw new Error("not implemented");
  }
  async exists(p) {
    throw new Error("not implemented");
  }
}
