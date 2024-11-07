import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { FormData, fetch } from "undici";
import "node:process";

const accountId: string = ""; // Replace with your actual account ID
const filesDirectory: string = "assets"; // Adjust to your assets directory
const scriptName: string = "my-new-script"; // Replace with desired script name

interface FileMetadata {
  hash: string;
  size: number;
}

interface UploadSessionData {
  uploadToken: string;
  buckets: string[][];
  fileMetadata: Record<string, FileMetadata>;
}

interface UploadResponse {
  result: {
    jwt: string;
    buckets: string[][];
  };
  success: boolean;
  errors: any;
  messages: any;
}

// Function to calculate the SHA-256 hash of a file and truncate to 32 characters
function calculateFileHash(filePath: string): {
  fileHash: string;
  fileSize: number;
} {
  const hash = crypto.createHash("sha256");
  const fileBuffer = fs.readFileSync(filePath);
  hash.update(fileBuffer);
  const fileHash = hash.digest("hex").slice(0, 32); // Grab the first 32 characters
  const fileSize = fileBuffer.length;
  return { fileHash, fileSize };
}

// Function to gather file metadata for all files in the directory
function gatherFileMetadata(directory: string): Record<string, FileMetadata> {
  const files = fs.readdirSync(directory);
  const fileMetadata: Record<string, FileMetadata> = {};

  files.forEach((file) => {
    const filePath = path.join(directory, file);
    const { fileHash, fileSize } = calculateFileHash(filePath);
    fileMetadata["/" + file] = {
      hash: fileHash,
      size: fileSize,
    };
  });

  return fileMetadata;
}

function findMatch(
  fileHash: string,
  fileMetadata: Record<string, FileMetadata>
): string {
  for (let prop in fileMetadata) {
    const file = fileMetadata[prop] as FileMetadata;
    if (file.hash === fileHash) {
      return prop;
    }
  }
  throw new Error("unknown fileHash");
}

// Function to upload a batch of files using the JWT from the first response
async function uploadFilesBatch(
  jwt: string,
  fileHashes: string[][],
  fileMetadata: Record<string, FileMetadata>
): Promise<string> {
  const form = new FormData();

  fileHashes.forEach(async (bucket) => {
    bucket.forEach((fileHash) => {
      const fullPath = findMatch(fileHash, fileMetadata);
      const relPath = filesDirectory + "/" + path.basename(fullPath);
      const fileBuffer = fs.readFileSync(relPath);
      const base64Data = fileBuffer.toString("base64"); // Convert file to Base64

      form.append(
        fileHash,
        new File([base64Data], fileHash, {
          type: "text/html", // Modify Content-Type header based on type of file
        }),
        fileHash
      );
    });

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
        body: form,
      }
    );

    const data = (await response.json()) as UploadResponse;
    if (data && data.result.jwt) {
      return { completionToken: data.result.jwt };
    }
  });

  throw new Error("Should have received completion token");
}

async function scriptUpload(completionToken: string): Promise<void> {
  const form = new FormData();

  // Configure metadata
  form.append(
    "metadata",
    JSON.stringify({
      main_module: "index.mjs",
      compatibility_date: "2022-03-11",
      assets: {
        jwt: completionToken, // Provide the completion token from file uploads
      },
      bindings: [{ name: "ASSETS", type: "assets" }], // Optional assets binding to fetch from user worker
    })
  );

  // Configure (optional) user worker
  form.append(
    "@index.js",
    new File(
      [
        "export default {async fetch(request, env) { return new Response('Hello world from user worker!'); }}",
      ],
      "index.mjs",
      {
        type: "application/javascript+module",
      }
    )
  );

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      },
      body: form,
    }
  );

  if (response.status != 200) {
    throw new Error("unexpected status code");
  }
}

// Function to make the POST request to start the assets upload session
async function startUploadSession(): Promise<UploadSessionData> {
  const fileMetadata = gatherFileMetadata(filesDirectory);

  const requestBody = JSON.stringify({
    manifest: fileMetadata,
  });

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
    }
  );

  const data = (await response.json()) as UploadResponse;
  const jwt = data.result.jwt;

  return {
    uploadToken: jwt,
    buckets: data.result.buckets,
    fileMetadata,
  };
}

// Begin the upload session by uploading a new manifest
const { uploadToken, buckets, fileMetadata } = await startUploadSession();

// If all files are already uploaded, a completion token will be immediately returned. Otherwise,
// we should upload the missing files
let completionToken = uploadToken;
if (buckets.length > 0) {
  completionToken = await uploadFilesBatch(uploadToken, buckets, fileMetadata);
}

// Once we have uploaded all of our files, we can upload a new script, and assets, with completion token
await scriptUpload(completionToken);
