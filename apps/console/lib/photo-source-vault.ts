const databaseName = "shuzhiren-photo-sources";
const storeName = "sources";
const maxPhotoBytes = 25 * 1024 * 1024;

type PhotoSource = { assetId: string; name: string; type: string; lastModified: number; blob: Blob };

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("此浏览器不支持本机照片缓存。"));
      return;
    }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: "assetId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打开本机照片缓存失败。"));
    request.onblocked = () => reject(new Error("本机照片缓存正在升级，请关闭其他工作台标签后重试。"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本机照片缓存失败。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本机照片缓存已取消。"));
  });
}

export async function savePhotoSource(assetId: string, file: File) {
  if (!assetId || !/^image\/(jpeg|png)$/.test(file.type) || file.size > maxPhotoBytes) throw new Error("仅支持缓存 25 MB 内的 JPEG 或 PNG 照片。");
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put({ assetId, name: file.name, type: file.type, lastModified: file.lastModified, blob: file } satisfies PhotoSource);
    await transactionDone(transaction);
  } finally { database.close(); }
}

export async function getPhotoSource(assetId: string) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(assetId) as IDBRequest<PhotoSource | undefined>;
    const source = await new Promise<PhotoSource | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("读取本机照片缓存失败。"));
    });
    await transactionDone(transaction);
    return source ? new File([source.blob], source.name, { type: source.type, lastModified: source.lastModified }) : null;
  } finally { database.close(); }
}

export async function deletePhotoSource(assetId: string) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(assetId);
    await transactionDone(transaction);
  } finally { database.close(); }
}
