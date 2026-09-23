# Réponses Test technique TanàImmo

## Partie 1 Revue de code

### Extrait A Composant React `ListingList`

| # | Problème | Gravité | Correction proposée |
|---|---|---|---|
| 1 | `useEffect` sans tableau de dépendances, refetch à chaque render, et le `setState` à l'intérieur redéclenche un render, boucle infinie de requêtes | Critique | Ajouter `[city]` comme tableau de dépendances |
| 2 | Aucune gestion d'erreur sur le `fetch` (pas de `.catch`, pas de vérification de `r.ok`) écran bloqué sur "Chargement…" en cas d'échec réseau ou d'erreur serveur | Élevée | Ajouter un état `error`, vérifier `r.ok` et l'afficher à l'utilisateur |
| 3 | Pas de `key` sur les `<li>` du `.map()` | Moyenne | `key={l.id}` |
| 4 | Pas d'annulation de la requête en cours si `city` change avant la fin du fetch précédent (race condition : une réponse "en retard" peut écraser des données plus récentes), et `setState` peut être appelé après démontage du composant | Élevée | `AbortController` dans le `useEffect`, + fonction de cleanup qui annule/ignore la requête |
| 5 | `l.price.toLocaleString()` plante si `price` est `null`/`undefined` (ex : annonce "prix à négocier") | Moyenne | Vérifier `l.price != null` avant l'appel, sinon afficher un texte de repli |
