# GR0UT — Notif batailles Carte Globale (Cloudflare Worker)

Prévient dans Discord avant chaque bataille de **Carte Globale** du clan GR0UT
(map + heure + adversaire), ping le rôle **@Soldats [GR0UT]**, et annonce les
**provinces gagnées/perdues**.

> Remplace l'ancien bot GitHub Actions : GitHub **throttlait** les workflows
> planifiés à ~1 run/heure, ce qui faisait sauter des notifs. Les **Cron Triggers
> de Cloudflare sont fiables** (toutes les 5 min).

## Comment ça marche

- **Source** : `wot/globalmap/clanbattles` = les batailles où le clan a
  **réellement posé une division** (pas de fausse défense non défendue). Les
  heures sont des **timestamps unix** → aucun souci de fuseau.
- Fenêtre de notif **15–90 min** avant la bataille ; anti-doublon en **KV**.
- Suivi des provinces via `wot/globalmap/clanprovinces` (diff en KV).
- Cron **`*/5 12-23 * * *`** (UTC) → fiable.

## Config

| | |
|---|---|
| Var `CLAN_ID` | `500165786` (GR0UT) |
| Var `CW_ROLE_ID` | rôle à ping (Soldats [GR0UT]) |
| Secret `WG_APP_ID` | Application ID Wargaming |
| Secret `DISCORD_WEBHOOK_URL` | webhook du salon batailles |
| Secret `RUN_SECRET` | protège la route de test `/run` |
| KV `STATE` | état (anti-doublon + provinces) |

## Déploiement

```bash
npm install
npx wrangler kv namespace create STATE      # coller l'id dans wrangler.toml
npx wrangler secret put WG_APP_ID
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put RUN_SECRET
npx wrangler deploy
```

## Test manuel

```
GET https://<worker>.workers.dev/run?key=<RUN_SECRET>
```
Renvoie un petit JSON `{provinces, battles, posted}`. Le 1er appel enregistre la
baseline des provinces (aucune annonce).

## Notes

- Les manches de tournoi n'apparaissent dans l'API qu'une fois la précédente
  gagnée (~45 min avant) → pour celles-ci la notif arrive ~30-45 min avant (max
  possible côté WG). Le plancher bas (15 min) + cron 5 min garantit qu'elles
  passent malgré tout.
- Réglages `LEAD_MIN` / `LEAD_MAX` en tête de `src/index.js`.
