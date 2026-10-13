/**
 * RSVP API — Vercel-compatible serverless handler.
 * Also used by local server.mjs.
 *
 * POST /api/rsvp
 * Body: { name, phone, attendance, number_of_guests, message }
 *    or { action: "like", id: "<id>" }
 *
 * GET /api/rsvp — guestbook wishes (name, message, created_at, likes)
 *
 * Likes are stored in a hidden meta row (`__wish_likes__`) so they work
 * without adding a DB column.
 */
import { createClient } from "@supabase/supabase-js";

const MESSAGE_MAX = 400;
const LIKES_MARKER = "__wish_likes__";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INT_ID_RE = /^[1-9]\d{0,18}$/;

function isValidWishId(id) {
  return UUID_RE.test(id) || INT_ID_RE.test(id);
}

function coerceWishId(id) {
  if (UUID_RE.test(id)) return id;
  if (INT_ID_RE.test(id)) return Number(id);
  return null;
}

function json(res, status, body) {
  if (typeof res.status === "function" && typeof res.json === "function") {
    return res.status(status).json(body);
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sanitizeText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, max);
}

function normalizePhone(value) {
  return sanitizeText(value, 32).replace(/[^\d+\s()-]/g, "");
}

function parseAttendance(raw) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") {
    if (raw === 1) return true;
    if (raw === 0) return false;
  }
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (["true", "1", "hadir", "attending", "yes", "ya"].includes(value)) {
    return true;
  }
  if (
    ["false", "0", "tidak_hadir", "tidak-hadir", "not_attending", "no", "tidak"].includes(
      value
    )
  ) {
    return false;
  }
  return null;
}

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!url || !key) return null;
  try {
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (err) {
    console.error("Supabase config error:", err.message);
    return null;
  }
}

function parseLikesMap(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (INT_ID_RE.test(String(key)) && Number.isFinite(n) && n > 0) {
        map[String(key)] = Math.floor(n);
      }
    }
    return map;
  } catch {
    return {};
  }
}

async function loadLikesStore(supabase) {
  const { data, error } = await supabase
    .from("rsvp")
    .select("id, message")
    .eq("name", LIKES_MARKER)
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Likes store read error:", error);
    return { rowId: null, map: {} };
  }

  return {
    rowId: data?.id ?? null,
    map: parseLikesMap(data?.message),
  };
}

async function saveLikesStore(supabase, rowId, map) {
  const message = JSON.stringify(map);
  if (rowId != null) {
    const { error } = await supabase
      .from("rsvp")
      .update({ message })
      .eq("id", rowId);
    if (error) throw error;
    return rowId;
  }

  const { data, error } = await supabase
    .from("rsvp")
    .insert([
      {
        name: LIKES_MARKER,
        phone: "00000000",
        attendance: false,
        number_of_guests: 0,
        message,
      },
    ])
    .select("id")
    .single();

  if (error) throw error;
  return data?.id ?? null;
}

function mapWish(row, likesMap) {
  const id = row.id != null ? String(row.id) : null;
  const fromCol = Number(row.likes);
  const fromMap = id ? Number(likesMap[id] || 0) : 0;
  const likes = Math.max(
    Number.isFinite(fromCol) && fromCol > 0 ? Math.floor(fromCol) : 0,
    Number.isFinite(fromMap) && fromMap > 0 ? Math.floor(fromMap) : 0
  );

  return {
    id,
    name: sanitizeText(row.name, 120),
    message: sanitizeText(row.message, MESSAGE_MAX),
    created_at: row.created_at || null,
    likes,
  };
}

export function validateRsvpPayload(raw) {
  const errors = {};
  const name = sanitizeText(raw?.name, 120);
  const phone = normalizePhone(raw?.phone);
  const attendance = parseAttendance(raw?.attendance);
  const message = sanitizeText(raw?.message, MESSAGE_MAX);

  if (!name || name.length < 2) {
    errors.name = "Sila masukkan nama anda.";
  }
  if (name === LIKES_MARKER) {
    errors.name = "Sila masukkan nama anda.";
  }
  if (!phone || phone.replace(/\D/g, "").length < 8) {
    errors.phone = "Sila masukkan nombor telefon yang sah.";
  }
  if (attendance === null) {
    errors.attendance = "Sila pilih status kehadiran.";
  }

  let numberOfGuests = Number.parseInt(raw?.number_of_guests, 10);
  if (attendance === false) {
    numberOfGuests = 0;
  } else if (attendance === true) {
    if (!Number.isFinite(numberOfGuests) || numberOfGuests < 1) {
      errors.number_of_guests = "Bilangan tetamu mestilah sekurang-kurangnya 1.";
      numberOfGuests = 1;
    } else if (numberOfGuests > 20) {
      errors.number_of_guests = "Bilangan tetamu maksimum ialah 20.";
      numberOfGuests = 20;
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    data: {
      name,
      phone,
      attendance,
      number_of_guests: numberOfGuests,
      message: message || null,
    },
  };
}

export async function handleWishLike(body, res) {
  const rawId = sanitizeText(body?.id, 64);
  if (!rawId || !isValidWishId(rawId)) {
    return json(res, 400, {
      ok: false,
      message: "Ucapan tidak sah.",
    });
  }
  const id = coerceWishId(rawId);
  const action = String(body?.action || "like").toLowerCase();
  const isUnlike = action === "unlike" || action === "dislike";

  const supabase = getSupabase();
  if (!supabase) {
    return json(res, 500, {
      ok: false,
      message: "Konfigurasi pelayan RSVP belum lengkap.",
    });
  }

  try {
    const { data: wish, error: wishError } = await supabase
      .from("rsvp")
      .select("id, name, message")
      .eq("id", id)
      .maybeSingle();

    if (wishError) {
      console.error("Wish like lookup error:", wishError);
      return json(res, 500, {
        ok: false,
        message: "Maaf, sukaan gagal dihantar.",
      });
    }

    if (
      !wish ||
      wish.name === LIKES_MARKER ||
      !String(wish.message || "").trim()
    ) {
      return json(res, 404, {
        ok: false,
        message: "Ucapan tidak dijumpai.",
      });
    }

    const store = await loadLikesStore(supabase);
    const key = String(rawId);
    const current = Math.max(0, Number(store.map[key]) || 0);
    const nextLikes = isUnlike ? Math.max(0, current - 1) : current + 1;

    if (nextLikes === 0) {
      delete store.map[key];
    } else {
      store.map[key] = nextLikes;
    }
    await saveLikesStore(supabase, store.rowId, store.map);

    return json(res, 200, {
      ok: true,
      id: key,
      likes: nextLikes,
      liked: !isUnlike,
    });
  } catch (err) {
    console.error("Wish like handler error:", err);
    return json(res, 500, {
      ok: false,
      message: "Maaf, berlaku ralat.",
    });
  }
}

export async function handleRsvpPost(body, res) {
  const action = String(body?.action || "").toLowerCase();
  if (action === "like" || action === "unlike" || action === "dislike") {
    return handleWishLike(body, res);
  }

  const parsed = validateRsvpPayload(body);
  if (!parsed.ok) {
    return json(res, 400, {
      ok: false,
      message: "Sila semak maklumat yang diisi.",
      errors: parsed.errors,
    });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return json(res, 500, {
      ok: false,
      message: "Konfigurasi pelayan RSVP belum lengkap.",
    });
  }

  try {
    const { data, error } = await supabase
      .from("rsvp")
      .insert([parsed.data])
      .select("name, attendance, number_of_guests")
      .single();

    if (error) {
      console.error("RSVP insert error:", error);
      return json(res, 500, {
        ok: false,
        message: "Maaf, RSVP gagal dihantar. Sila cuba lagi.",
      });
    }

    return json(res, 201, {
      ok: true,
      message: "RSVP berjaya diterima.",
      rsvp: data,
    });
  } catch (err) {
    console.error("RSVP handler error:", err);
    return json(res, 500, {
      ok: false,
      message: "Maaf, berlaku ralat. Sila cuba lagi.",
    });
  }
}

export async function handleRsvpGet(res) {
  const supabase = getSupabase();
  if (!supabase) {
    return json(res, 500, {
      ok: false,
      message: "Konfigurasi pelayan RSVP belum lengkap.",
    });
  }

  try {
    const [{ data, error }, likesStore] = await Promise.all([
      supabase
        .from("rsvp")
        .select("id, name, message, created_at")
        .not("message", "is", null)
        .neq("message", "")
        .neq("name", LIKES_MARKER)
        .order("created_at", { ascending: false })
        .limit(100),
      loadLikesStore(supabase),
    ]);

    if (error) {
      console.error("RSVP list error:", error);
      return json(res, 500, {
        ok: false,
        message: "Maaf, ucapan gagal dimuatkan.",
      });
    }

    const wishes = (data || [])
      .map((row) => mapWish(row, likesStore.map))
      .filter((row) => row.name && row.message && row.name !== LIKES_MARKER);

    return json(res, 200, {
      ok: true,
      wishes,
    });
  } catch (err) {
    console.error("RSVP list handler error:", err);
    return json(res, 500, {
      ok: false,
      message: "Maaf, berlaku ralat.",
    });
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader?.("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader?.("Access-Control-Allow-Headers", "Content-Type");
    return json(res, 204, {});
  }

  if (req.method === "GET") {
    return handleRsvpGet(res);
  }

  if (req.method !== "POST") {
    return json(res, 405, { ok: false, message: "Method not allowed." });
  }

  return handleRsvpPost(req.body || {}, res);
}
