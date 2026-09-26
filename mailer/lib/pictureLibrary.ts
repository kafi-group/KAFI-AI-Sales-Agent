/** Shared mailer picture library — groups of hosted images (Railway). */

import { ApiError, getApiBase, getStoredToken } from "./api";

export type PictureLibraryImage = {
  id: string;
  url: string;
  filename: string;
  content_type: string;
  size: number;
  uploaded_by?: string;
  created_at?: string;
};

export type PictureLibraryGroup = {
  id: string;
  name: string;
  created_at?: string;
  created_by?: string;
  images: PictureLibraryImage[];
};

export type PictureLibrary = {
  groups: PictureLibraryGroup[];
};

async function authFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const base = getApiBase();
  if (!base) {
    throw new ApiError(
      500,
      "KAFI_API_BASE_URL / NEXT_PUBLIC_KAFI_API_BASE_URL is not set on the mailer.",
    );
  }
  const token = getStoredToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // Do not force JSON Content-Type — multipart uploads need the browser boundary.
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const detail =
      data && typeof data === "object" && data !== null && "detail" in data
        ? String((data as { detail: unknown }).detail)
        : text || res.statusText;
    throw new ApiError(res.status, detail);
  }
  return data as T;
}

export async function fetchPictureLibrary(): Promise<PictureLibrary> {
  return authFetch<PictureLibrary>("/mailer/picture-library");
}

export async function createPictureGroup(name: string): Promise<PictureLibraryGroup> {
  const data = await authFetch<{ group: PictureLibraryGroup }>(
    "/mailer/picture-library/groups",
    { method: "POST", body: JSON.stringify({ name }) },
  );
  return data.group;
}

export async function renamePictureGroup(
  groupId: string,
  name: string,
): Promise<PictureLibraryGroup> {
  const data = await authFetch<{ group: PictureLibraryGroup }>(
    `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/rename`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  return data.group;
}

export async function deletePictureGroup(groupId: string): Promise<void> {
  await authFetch(`/mailer/picture-library/groups/${encodeURIComponent(groupId)}/delete`, {
    method: "POST",
  });
}

export async function uploadPictureToGroup(
  groupId: string,
  file: File,
): Promise<PictureLibraryImage> {
  const form = new FormData();
  form.append("file", file);
  const data = await authFetch<{ image: PictureLibraryImage }>(
    `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/images`,
    { method: "POST", body: form },
  );
  return data.image;
}

export async function deletePictureFromGroup(
  groupId: string,
  mediaId: string,
): Promise<void> {
  await authFetch(
    `/mailer/picture-library/groups/${encodeURIComponent(groupId)}/images/${encodeURIComponent(mediaId)}/delete`,
    { method: "POST" },
  );
}
