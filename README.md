# Kalendari i Vjeljes

PWA me kalendarin e vjeljes për Prishtinën dhe Opojën/Dragashin, me njoftime në telefon.

## Përmbajtja
- `public/` — aplikacioni: `index.html`, `crops.json` (të dhënat e kulturave), `sw.js` (punon pa internet dhe shfaq njoftimet), ikonat dhe fontet.
- `src/worker.js` — shërbimi në Cloudflare: ruan abonimet dhe çdo mëngjes në 8:00 (ora e Kosovës) dërgon njoftim kur fillon vjelja e një kulture.
- `wrangler.jsonc` — konfigurimi i Cloudflare: KV `SUBS` për abonimet, orari (cron) dhe çelësi publik.

## Si funksionojnë njoftimet
1. Në aplikacion shtypni **Aktivizo njoftimet** dhe zgjidhni zonat, llojet dhe kur doni njoftimin (ditën që fillon, 3 ditë ose 1 javë para).
2. Shërbimi kontrollon çdo ditë në 8:00. Njoftim vjen vetëm kur fillon diçka që keni zgjedhur.
3. Në Android punojnë në Chrome, edhe kur aplikacioni është i mbyllur. Në iPhone duhet iOS 16.4 ose më i ri dhe aplikacioni i shtuar në ekranin bazë.

## Sekreti
`VAPID_PRIVATE_KEY` vendoset si sekret në Cloudflare (te Worker-i, Variables and Secrets) dhe nuk ruhet në kod. Nëse ndryshohet, të gjithë duhet t'i aktivizojnë njoftimet sërish.

## Ndryshimet
- Datat e kulturave: ndryshoni `public/crops.json`.
- Pas çdo ndryshimi në aplikacion, ndryshoni `VERSION` në `public/sw.js`, që telefonat ta marrin versionin e ri vetë.
