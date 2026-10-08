// Parent profile: nickname + profile photo.
//
// The backend has no avatar/nickname fields (and the API contract is not
// changing for a styling pass), so these are stored per-user on this device in
// localStorage. The photo is downscaled before saving so it stays small.

import { firstNameOf } from "./dom.js";

const AVATAR_PX = 320;
const MAX_NICKNAME = 30;

function storageKey(userId) {
  return `ypia_profile_${userId}`;
}

export function loadProfile(user) {
  const empty = { nickname: "", avatar: "" };
  if (!user?.id) return empty;
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(user.id)) || "null");
    return {
      nickname: typeof raw?.nickname === "string" ? raw.nickname : "",
      avatar: typeof raw?.avatar === "string" && raw.avatar.startsWith("data:image/") ? raw.avatar : "",
    };
  } catch {
    return empty;
  }
}

// Returns false if the browser refused to store it (e.g. storage full).
export function saveProfile(user, profile) {
  if (!user?.id) return false;
  try {
    localStorage.setItem(storageKey(user.id), JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function cleanNickname(value) {
  return (value || "").replace(/\s+/g, " ").trim().slice(0, MAX_NICKNAME);
}

// What we call the parent in the UI: their nickname, else their first name.
export function displayNameFor(user, profile) {
  return profile.nickname || firstNameOf(user?.fullName) || "there";
}

// Center-crops to a square and resizes. Rejects with a readable message.
export function imageFileToAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("Please choose a photo (JPG or PNG)."));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) {
        reject(new Error("That photo couldn't be read. Please try another."));
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = AVATAR_PX;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(
        img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, AVATAR_PX, AVATAR_PX
      );
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That photo couldn't be read. Please try another."));
    };
    img.src = url;
  });
}
