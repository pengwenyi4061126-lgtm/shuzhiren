export type ProjectRecordingOutput = {
  id: string;
  projectId: string;
  projectName: string;
  projectRevision: number;
  productVersionId?: string;
  scriptSnapshot: string;
  photoAssetId: string;
  voiceAssetId?: string;
  voiceAssetName?: string;
  fileName: string;
  createdAt: string;
  size: number;
  contentType: string;
  blob: Blob;
  serverArchive?: { status: "archived" | "failed" | "local-only"; recordingId?: string; message?: string };
};

const databaseName = "shuzhiren-project-recordings";
const legacyStoreName = "outputs";
const storeName = "output-versions";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("此浏览器不支持本机项目输出保存。"));
      return;
    }
    const request = indexedDB.open(databaseName, 2);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      const versions = database.objectStoreNames.contains(storeName)
        ? transaction?.objectStore(storeName)
        : database.createObjectStore(storeName, { keyPath: "id" });
      if (!versions) return;
      if (!versions.indexNames.contains("projectId")) versions.createIndex("projectId", "projectId");
      if (event.oldVersion === 1 && transaction && database.objectStoreNames.contains(legacyStoreName)) {
        const cursorRequest = transaction.objectStore(legacyStoreName).openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            database.deleteObjectStore(legacyStoreName);
            return;
          }
          const output = cursor.value as Omit<ProjectRecordingOutput, "id">;
          versions.put({ ...output, id: `legacy-${output.projectId}` });
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打开本机项目存储失败。"));
    request.onblocked = () => reject(new Error("本机项目存储正在升级，请关闭其他工作台标签后重试。"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本机项目存储失败。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本机项目存储已取消。"));
  });
}

export async function saveProjectRecording(output: Omit<ProjectRecordingOutput, "id">) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    const version = { ...output, id: crypto.randomUUID() };
    transaction.objectStore(storeName).add(version);
    await transactionDone(transaction);
    return version;
  } finally {
    database.close();
  }
}

export async function listProjectRecordings(projectId: string) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).index("projectId").getAll(projectId) as IDBRequest<ProjectRecordingOutput[]>;
    const outputs = await new Promise<ProjectRecordingOutput[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("读取本机项目输出失败。"));
    });
    await transactionDone(transaction);
    return outputs.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  } finally {
    database.close();
  }
}

export async function updateProjectRecordingArchive(projectId: string, outputId: string, serverArchive: ProjectRecordingOutput["serverArchive"]) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.get(outputId) as IDBRequest<ProjectRecordingOutput | undefined>;
    const output = await new Promise<ProjectRecordingOutput | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("读取本机项目输出失败。"));
    });
    if (!output || output.projectId !== projectId) {
      transaction.abort();
      throw new Error("找不到要更新的本机项目版本。");
    }
    const updated = { ...output, serverArchive };
    store.put(updated);
    await transactionDone(transaction);
    return updated;
  } finally {
    database.close();
  }
}
