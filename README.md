# TanàImmo Test technique développeur React (fiabilité de plateforme)

## Contenu du dépôt

- `REPONSES.md` : tableaux de bugs (Partie 1) + rédaction (Partie 3)
- `routes/listings.js` : extrait B corrigé (route de recherche d'annonces)
- `webhooks/payment.js` : extrait C corrigé (webhook de confirmation de paiement)
- `crm/crm-client.ts` : connecteur CRM (Partie 2)
- `test/crm-client.test.ts` : tests unitaires du connecteur CRM

## Lancer les tests

```bash
npm install
npm test
```

Utilise le test runner intégré de Node.js (`node --test`) via `tsx` pour exécuter le TypeScript
directement, sans étape de build séparée. Aucune base de données ni serveur externe requis :
le fetch vers l'API CRM est mocké dans les tests.

## Ce qui a été fait

- Partie 1 : analyse complète des 3 extraits (tableaux dans `REPONSES.md`), code corrigé pour
  B et C.
- Partie 2 : `crmClient.createLead()` avec timeout 5s, retry + backoff exponentiel, respect du
  header `Retry-After` sur 429, pas de retry sur 4xx définitifs, clé d'idempotence, token jamais
  loggé. 3 tests unitaires (les 2 demandés + un test sur le cas 400/pas de retry).
- Partie 3 : rédaction complète dans `REPONSES.md`.

## Ce qui n'a pas été fait / limites connues

- **Vérification de signature du webhook de paiement** : non implémentée dans le code rendu.
  Le mécanisme exact du prestataire (header utilisé, algorithme, format du secret) n'est pas
  spécifié dans l'énoncé ; j'ai laissé un `TODO` explicite dans `webhooks/payment.js` plutôt
  que d'implémenter une vérification basée sur une hypothèse arbitraire qui n'aurait pas
  correspondu au vrai prestataire.
- Le stockage des `event.id` déjà traités (idempotence du webhook) et des leads créés est en
  mémoire (`Set`), conformément à la consigne "tout peut être simulé en mémoire". Deux limites
  à connaître avant une mise en prod réelle :
  - **non partagé entre plusieurs instances** : sous forte charge (campagnes marketing pics
    de trafic, donc probablement plusieurs instances derrière un load balancer), deux instances
    différentes ne se voient pas et pourraient chacune traiter le même event webhook ou créer
    deux fois le même lead ;
  - **`has()` puis `add()` non atomiques** : même sur une seule instance, deux requêtes quasi
    simultanées pour le même event peuvent toutes les deux passer le test avant que l'une des
    deux ne marque l'event comme traité.
  À remplacer par une contrainte unique en base (`UNIQUE` sur `event_id`, avec
  `INSERT ... ON CONFLICT DO NOTHING`) avant la mise en prod.
- Le délai d'attente sur 429 (CRM) est plafonné à 10s même si `Retry-After` demande plus long,
  pour éviter qu'une requête reste bloquée trop longtemps côté appelant choix assumé, pas
  un oubli.
- Pas de linter/CI configuré (hors périmètre du test).
- Extrait A : correction discutée dans `REPONSES.md` mais non livrée en code, comme demandé
  par l'énoncé.

## Temps réellement passé

*2h*