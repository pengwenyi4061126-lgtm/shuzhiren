export type ProjectRecordingOutput = {
  projectId: string;
  projectName: string;
  projectRevision: number;
  scriptSnapshot: string;
  photoAssetId: string;
  fileName: string;
  createdAt: string;
  size: number;
  contentType: string;
  blob: Blob;
};

const databaseName = "shuzhiren-project-recordings";
const storeName = "outputs";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("此浏览器不支持本机项目输出保存。"));
      return;
    }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: "projectId" });
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

export async function saveProjectRecording(output: ProjectRecordingOutput) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(output);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function getProjectRecording(projectId: string) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(projectId) as IDBRequest<ProjectRecordingOutput | undefined>;
    const output = await new Promise<ProjectRecordingOutput | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("读取本机项目输出失败。"));
    });
    await transactionDone(transaction);
    return output;
  } finally {
    database.close();
  }
}
