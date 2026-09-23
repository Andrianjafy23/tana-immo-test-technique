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


## Partie 3 Gestion d'incident

### 3.1 Scénario : pic d'erreurs 5xx après le lancement de la campagne SMS

**Les 30 premières minutes, dans l'ordre :**

1. **Accusé de réception (< 1 min)** : je confirme au client par message que j'ai vu l'alerte et que je regarde, sans plus de détails techniques à ce stade, pas de promesse de délai que je ne peux pas tenir.
2. **Premières vérifications (2-3 min)** : je regarde le dashboard de monitoring, quelle route concentre les erreurs 5xx ? Le taux CPU/mémoire des instances API et de la DB ? Le nombre de connexions actives à PostgreSQL (pool épuisé ?). Vu le contexte (campagne SMS pic de trafic sur les annonces), mon hypothèse immédiate est que l'**extrait B est en production** : le pattern N+1 en boucle séquentielle sature le pool de connexions DB, d'où les timeouts et les 5xx en cascade.
3. **Vérification de l'hypothèse (3-5 min)** : je regarde les logs et les métriques DB, nombre de requêtes par seconde vers `agencies`/`photos`, temps de réponse par requête, nombre de connexions en attente dans le pool. Si le pattern N+1 est confirmé, c'est cohérent avec un temps de réponse médian à 9s.
4. **Mitigation immédiate, même sans certitude à 100 %** :
   - Si le pool DB est saturé : augmenter temporairement sa taille (si l'infra le permet en quelques minutes) ou réduire volontairement la charge (rate limiting sur `/api/listings`, ou activer un cache CDN/edge de quelques secondes sur cette route en lecture seule).
   - Si un déploiement récent est en cause, envisager un rollback vers la dernière version stable plutôt que de chercher à corriger à chaud sous pression.
   - Vérifier si le pic vient d'un pattern de trafic anormal (bot, retry client) qu'on pourrait filtrer en amont (WAF/rate limit par IP).
5. **Communication au client** : dès que j'ai une hypothèse solide (pas juste "je regarde"), je le préviens en langage simple : *"On a identifié la cause probable : une partie de l'API interroge la base de données de façon inefficace sous forte charge. On met en place une mitigation immédiate pendant qu'on prépare le correctif."* Je donne une estimation prudente du délai, et je m'engage à revenir vers lui à un horaire précis plutôt que de le laisser sans nouvelles.
6. **Stabilisation** : une fois la mitigation en place, je confirme que le taux d'erreurs redescend en observant le dashboard en temps réel avant de déclarer l'incident "sous contrôle".

**Le lendemain, une fois la situation stabilisée :**
- Rédiger un post-mortem court (cause racine, chronologie, impact, actions correctives) et le partager avec le client.
- Déployer le vrai correctif (requêtes groupées + pagination) en environnement de test, avec un test de charge simulant le pic observé, avant de le remettre en prod.
- Revoir le dimensionnement du pool DB et des instances API pour absorber ce type de pic à l'avenir.
- Vérifier qu'aucune donnée n'a été corrompue par les erreurs (ex : réservations dans un état incohérent).

### 3.2 Avant le lancement : alertes à mettre en place

1. **Taux d'erreurs 5xx > 1 % sur 5 min glissantes** (Datadog / Grafana + Prometheus) signal principal de dégradation de service.
2. **Temps de réponse P95 > 2s sur 5 min glissantes** détecte une dégradation avant qu'elle ne devienne un taux d'erreur franc.
3. **Connexions actives au pool PostgreSQL > 80 % de la capacité configurée** alerte précoce sur le pattern N+1 / saturation DB, avant l'impact utilisateur.
4. **Health check externe (uptime monitor type Better Uptime / Pingdom) sur la page d'accueil et `/api/listings`, ping toutes les 30s** filet de sécurité indépendant de l'infra interne, pour être alerté même si le monitoring interne est lui-même en panne.

---