const avatarKeys = Object.freeze([
  "avatar_part1_1.webp",
  "avatar_part1_2.webp",
  "avatar_part1_3.webp",
  "avatar_part1_4.webp",
  "avatar_part3_1.webp",
  "avatar_part3_2.webp",
  "avatar_part3_3.webp",
  "avatar_part3_4.webp",
]);

function hashSeed(seed = "") {
  const value = String(seed).trim();
  if (!value) return 0;

  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function getAvatarSeed(user = {}) {
  return (
    user._id?.toString?.() ||
    user.id?.toString?.() ||
    user.email ||
    user.name ||
    "default-avatar"
  );
}

function getDeterministicAvatarKey(seed) {
  const index = hashSeed(seed) % avatarKeys.length;
  return avatarKeys[index];
}

function normalizeAvatarKey(avatarKey) {
  const value = String(avatarKey || "").trim();
  return avatarKeys.includes(value) ? value : "";
}

function resolveUserAvatarKey(user = {}) {
  const normalized = normalizeAvatarKey(user.avatarKey);
  if (normalized) {
    return normalized;
  }

  return getDeterministicAvatarKey(getAvatarSeed(user));
}

function ensureUserAvatarKey(user) {
  if (!user) return "";
  const resolved = resolveUserAvatarKey(user);
  user.avatarKey = resolved;
  return resolved;
}

function withResolvedAvatar(user) {
  if (!user) return user;

  const plainUser =
    typeof user.toObject === "function" ? user.toObject() : { ...user };

  plainUser.avatarKey = resolveUserAvatarKey(plainUser);
  return plainUser;
}

module.exports = {
  avatarKeys,
  getDeterministicAvatarKey,
  normalizeAvatarKey,
  resolveUserAvatarKey,
  ensureUserAvatarKey,
  withResolvedAvatar,
};
