# Corpus de tests de régression

Le test d'intégration `tests/corpus.rs` exerce le moteur d'édition sur :

1. **Des PDF synthétiques** générés à la volée (crénage TJ, colonnes,
   cellules clippées, fonds blancs peints après le texte, multiligne,
   encodages restreints) — toujours exécutés.
2. **Tous les PDF déposés dans `private/`** — documents RÉELS (devis,
   factures clients…). Ce dossier est **gitignoré** : rien n'en sort jamais
   (le dépôt est public). Déposez-y les documents qui ont déclenché un bug
   pour qu'ils soient rejoués à chaque exécution des tests.

Lancer :

```bash
ALTO_PDFIUM_DIR="$(cd ../../src-tauri && pwd)" cargo test --release -p alto-pdf-engine --test corpus
```

Invariants vérifiés sur chaque document :

- l'analyse réussit et TOUS les blocs texte ordinaires sont éligibles à
  l'édition native selon les règles exactes du frontend (alignement 1:1
  texte ↔ glyphes, glyphes mappés sur la page texte, indices croissants).
  Le texte des lignes étant reconstruit DEPUIS les glyphes fusionnés,
  l'alignement est garanti par construction. Seule exception tolérée :
  les glyphes peints dans le désordre du flux (logos multi-couches,
  textes superposés), exclus de l'édition par le frontend ;
- une insertion native réussit (ou échoue avec un code d'erreur CONNU,
  jamais une corruption silencieuse) ;
- après insertion, le texte attendu est présent et les voisins sont intacts ;
- la restauration du flux d'origine (undo par versionnage) ramène la page
  exactement à son état initial.
