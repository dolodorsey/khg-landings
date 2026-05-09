import landings from '../../data/landings.json';
import brands from '../../data/brands.json';

export type Landing = {
  brand_key: string;
  brand_name: string;
  short_name: string;
  ig_handle: string;
  website: string;
  primary: string;
  accent: string;
  dark: string;
  tagline: string;
  intent_name: string;
  intent_path: string;
  keywords: string[];
  pool: string | null;
  stage: number | null;
  action: string;
};

export type Brand = {
  brand_key: string;
  brand_name: string;
  short_name: string;
  division: string;
  ig_handle: string;
  website: string;
  primary_color: string;
  accent_color: string;
  dark_color: string;
  category?: string;
  contact_email?: string;
  voice: string;
  tagline: string;
  bio_text: string;
  link_in_bio_label: string;
  audience: string;
  highlights: { i: number; t: string; concept: string }[];
  pillar_mix: [string, number][];
  pinned: { slot: number; concept: string }[];
};

export const ALL_LANDINGS = landings as unknown as Landing[];
export const ALL_BRANDS = brands as unknown as Record<string, Brand>;

export function getLanding(brand: string, intent: string): Landing | undefined {
  return ALL_LANDINGS.find(
    (l) => l.brand_key === brand && l.intent_path === intent,
  );
}

export function getBrand(brand: string): Brand | undefined {
  return ALL_BRANDS[brand];
}

export function getAllRoutes(): { brand: string; intent: string }[] {
  return ALL_LANDINGS.map((l) => ({
    brand: l.brand_key,
    intent: l.intent_path,
  }));
}
