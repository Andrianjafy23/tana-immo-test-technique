# Réponses Test technique TanàImmo

## Partie 1 Revue de code

### Extrait A Composant React `listing-list`

| # | Problème | Gravité | Correction proposée |
|---|---|---|---|
| 1 | `useEffect` sans tableau de dépendances, refetch à chaque render, et le `setState` à l'intérieur redéclenche un render, boucle infinie de requêtes | Critique | Ajouter `[city]` comme tableau de dépendances |
| 2 | Aucune gestion d'erreur sur le `fetch` (pas de `.catch`, pas de vérification de `r.ok`) écran bloqué sur "Chargement…" en cas d'échec réseau ou d'erreur serveur | Élevée | Ajouter un état `error`, vérifier `r.ok` et l'afficher à l'utilisateur |
| 3 | Pas de `key` sur les `<li>` du `.map()` | Moyenne | `key={l.id}` |
| 4 | Pas d'annulation de la requête en cours si `city` change avant la fin du fetch précédent (race condition : une réponse "en retard" peut écraser des données plus récentes), et `setState` peut être appelé après démontage du composant | Élevée | `AbortController` dans le `useEffect`, + fonction de cleanup qui annule/ignore la requête |
| 5 | `l.price.toLocaleString()` plante si `price` est `null`/`undefined` (ex : annonce "prix à négocier") | Moyenne | Vérifier `l.price != null` avant l'appel, sinon afficher un texte de repli |

### Extrait B Route `/api/listings`

| # | Problème | Gravité | Correction proposée |
|---|---|---|---|
| 1 | Injection SQL : `city` est concaténé directement dans la requête SQL | Critique | Requête paramétrée (`$1`) |
| 2 | Problème N+1 : une requête `agencies` + une requête `photos` par ligne de résultat, exécutées séquentiellement dans une boucle très lent, et s'effondre sous un pic de trafic (justement le scénario annoncé par le client) | Critique | Deux requêtes groupées (`WHERE id = ANY($1)`) exécutées en parallèle, jointure faite en mémoire |
| 3 | `page` reçu en query mais jamais utilisé, aucune pagination, la route peut retourner l'intégralité de la table | Élevée | `LIMIT`/`OFFSET` avec taille de page fixe et bornée |
| 4 | Aucun `try/catch` une erreur DB remonte telle quelle (ou fait planter le process selon la config) | Élevée | `try/catch`, log serveur, réponse 500 générique côté client |
| 5 | Pas de validation de `city` (peut être absent, ou un tableau si `?city=a&city=b`) | Moyenne | Normalisation/validation du paramètre avant utilisation |

*(voir le code corrigé dans `routes/listings.js`)*


### Extrait C Webhook de confirmation de paiement

| # | Problème | Gravité | Correction proposée |
|---|---|---|---|
| 1 | Aucune vérification de signature/authenticité de l'appelant n'importe qui connaissant l'URL peut marquer une réservation comme payée | Critique | Vérifier la signature HMAC fournie par le prestataire avant tout traitement *(non implémenté dans le code rendu, faute de connaître le mécanisme exact du prestataire voir TODO dans `webhooks/payment.js`)* |
| 2 | Pas d'idempotence sur `event.id` : le prestataire réessaie jusqu'à 5 fois si la réponse n'arrive pas sous 10s un traitement lent peut déclencher l'envoi de plusieurs emails et plusieurs notifications CRM pour le même paiement | Critique | Stocker les `event.id` déjà traités et acquitter directement (200) sans rejouer les effets de bord si l'event est connu |
| 3 | Traitement 100% séquentiel avant la réponse (DB + email + appel CRM 2-8s) le total peut dépasser les 10s du prestataire et déclencher un retry alors que tout s'est en réalité bien passé | Élevée | Répondre 200 dès que la mise à jour DB (l'action critique) est faite ; traiter email et notification CRM en asynchrone après la réponse |
| 4 | Aucun `try/catch`  si `sendEmail` ou `crm.notifyPayment` lève une exception, la réponse n'est jamais envoyée, le prestataire réessaie indéfiniment un paiement déjà traité en DB | Élevée | Isoler chaque effet de bord dans son propre `try/catch`, ne jamais faire dépendre l'ACK du webhook de ces opérations non critiques |
| 5 | Pas de validation du corps de la requête (`event.type`, `event.booking_id`, etc.) avant utilisation | Moyenne | Validation minimale du schéma de l'event reçu |

*(voir le code corrigé dans `webhooks/payment.js`)*

---