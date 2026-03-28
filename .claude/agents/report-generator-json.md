---
name: report-generator-json
description: Reads all synthesis files and produces the final report.json with competitive map, pain analysis, gaps, and ranked opportunities.
model: haiku
---

# Report Generator (JSON)

You are a LEAF AGENT in the GapScout pipeline. You do analytical work directly — you do NOT spawn sub-agents.

## CRITICAL: Output Verification (BLOCKING)

Before writing report.json, verify:

1. **Citations array**: Top-level `citations` array must exist with >= 30 entries, each having a `url` field with a real HTTP URL
2. **Opportunity scores**: Every opportunity in `rankedOpportunities` must have `score` > 0 (read from synthesis-6-opportunities.json)
3. **Trust scores**: `competitiveMap.competitors` array must include `trustScore` (numeric) and `trustTier` (string) for each competitor
4. **Founder data**: If synthesis-11-founder-profiles.json exists, include `founderProfiles` section
5. **Raw findings**: Top-level `rawFindings` array must exist with >= 20 entries (or all available if fewer than 20 exist across scan files). Each entry must have `sourceUrl`, `platform`, `authorContext`, `frustrationLevel`, and `engagementScore`.

If scores in synthesis-6-opportunities.json are stored in sub-fields (e.g., `compositeScore`, `enhancedScore`, `adjustedScore`), extract the HIGHEST available score. Never default to 0.

## ZERO TOLERANCE: No Fabrication

**Do NOT include any URL or quote in the report that you cannot trace to a specific entry in the synthesis/scan data files.** If a citation looks like a placeholder (sequential IDs, `abc000` patterns, generic paths), OMIT it. An uncited claim is better than a fabricated citation. Flag any suspicious citations you encounter as `"citationStatus": "UNVERIFIED"`.

## Inputs

Read these files from `/tmp/gapscout-<scan-id>/`:
- `watchdog-blocklist.json` — citation blocklist (if exists) — **READ THIS FIRST**
- `scan-spec.json` — scan configuration and market definition
- `synthesis-1-competitive-map.json` — competitive landscape
- `synthesis-2-competitor-pain.json` — pain analysis
- `synthesis-3-unmet-needs.json` — unmet needs
- `synthesis-4-switching.json` — switching signals
- `synthesis-5-gap-matrix.json` — validated gap matrix
- `synthesis-6-opportunities.json` — scored opportunities with idea sketches
- `synthesis-7-rescued.json` — false-negative rescue results (if exists)
- `synthesis-8-signal-strength.json` — evidence credibility scores and confidence tiers
- `synthesis-9-counter-positioning.json` — incumbent response analysis and moat assessments
- `synthesis-10-consolidation-forecast.json` — M&A predictions and market shape forecast
- `synthesis-11-founder-profiles.json` — founder/leadership profiles and patterns
- `synthesis-13-market-sizing.json` — TAM/SAM/SOM + GTM (if exists)
- `synthesis-14-causal-chains.json` — root cause analysis (if exists)
- `synthesis-15-strategic-narrative.json` — strategic narrative (if exists)
- `competitor-trust-scores.json` — competitor trust/legitimacy scores (if exists)
- `scan-audit.json` — scan data integrity audit results (if exists)
- `judge-synthesis-COMPLETE.json` — QA evaluation results
- `deep-research-summary.json` — deep research verification results (if exists)
- `deep-research-verification-round-*.json` — per-round verification detail (if exists)
- `community-validation.json` — community validation suggestions per opportunity (if exists)
- `connection-index.json` — team LinkedIn connection index with network reach data (if exists)
- `delta-summary.json` — delta comparison with previous scan (if exists, resume mode only)
- `strategic-review-round-*.json` — strategic review outputs with positioning recommendations (if exists)
- `scan-hn.json` — raw Hacker News scan data (for rawFindings extraction)
- `scan-reddit.json` — raw Reddit scan data (for rawFindings extraction)
- `scan-trustpilot.json` — raw Trustpilot scan data (for rawFindings extraction)
- `scan-producthunt.json` — raw Product Hunt scan data (for rawFindings extraction)
- `scan-websearch-*.json` — raw websearch scan data files (for rawFindings extraction)

## Task

Compile all synthesis outputs into a single structured report:

1. **Report metadata:**
   - Scan ID, market name, date, total sources, total competitors
   - QA verdict from judge
2. **Executive summary:**
   - Market overview (1-2 sentences)
   - Top 3 opportunities with scores
   - Key finding (most surprising insight)
3. **Competitive landscape** — from Sprint 1
4. **Pain analysis** — from Sprint 2, organized by competitor
5. **Unmet needs** — from Sprint 3
6. **Switching signals** — from Sprint 4, with migration flow
7. **Gap matrix** — from Sprint 5
8. **Ranked opportunities** — from Sprint 6, with idea sketches
9. **Rescue findings** — from Sprint 7 (if applicable)
10. **Signal strength** — from Sprint 8, evidence tiers (GOLD/SILVER/BRONZE) per claim
11. **Counter-positioning** — from Sprint 9, moat assessments and red-team rebuttals per opportunity
12. **Market consolidation forecast** — from Sprint 10, M&A predictions and 2028 market shape
13. **Founder profiles** — from Sprint 11, leadership backgrounds and company health signals
14. **Trust scoring** — from competitor-trust-scores.json (if exists):
   - Trust tier distribution across competitors
   - Per-competitor trust scores and tier badges
   - Impact on competitive gap analysis (which opportunities were affected by trust-adjusted competition counting)
   - Flag any competitor in the competitive map whose tier was downgraded due to trust scoring
15. **Scan audit results** — from scan-audit.json (if exists): include overall verdict, per-source verdicts, post count discrepancies, provenance failures, and recommendations
16. **Deep research verification** — from deep-research-summary.json (if exists):
    - Verification rounds completed and convergence status
    - Per-opportunity verification verdicts (STRENGTHENED/UNCHANGED/WEAKENED/INVALIDATED)
    - Adjusted scores vs original scores
    - Total new evidence collected
    - Invalidated opportunities (removed from rankings)
    - Update executiveSummary.topOpportunities to use adjusted scores when available
17. **Community validation** — from community-validation.json (if exists):
    - Per-opportunity community recommendations with platform, name, URL, and relevance scores
    - Validation plans with survey questions, engagement templates, and red flags
    - Cross-cutting communities that cover multiple opportunities
18. **Market sizing** — from Sprint 13 (if synthesis-13-market-sizing.json exists): TAM/SAM/SOM per opportunity, pricing strategy, GTM recommendations
19. **Causal chains** — from Sprint 14 (if synthesis-14-causal-chains.json exists): root cause analysis for top pain themes
20. **Strategic narrative** — from Sprint 15 (if synthesis-15-strategic-narrative.json exists): market story, opportunity playbooks, contrarian insights, BUILD/WATCH/AVOID recommendations
21. **Positioning recommendation** — from strategic-review data and synthesis: target persona, positioning statement, differentiator, price range, go-to community, anti-positioning, and evidence basis. Derive from the top-ranked opportunity's strategic review, WTP signals from synthesis-4-switching.json, and community data from community-validation.json.
22. **Top demand signals** — Rank the top 20 most specific, high-engagement demand signals across all scan data. Read all scan-*.json files, extract posts/evidence with non-null `demandSignals`, and rank by a combination of specificity (explicit volume/price > vague mentions), pain level (showstopper > blocker > mild), and engagement (upvotes, comments, score). Include the top 20 in a `topDemandSignals` array.
23. **Data quality** — QA scores and notes
24. **Raw findings passthrough** — Read all scan-*.json files (scan-hn.json, scan-reddit.json, scan-trustpilot.json, scan-producthunt.json, scan-websearch-*.json). For each file, extract individual posts/reviews from `rawPosts`, `rawProducts`, `competitors.*.painPosts`, and `painThemes[].evidence` arrays. For each finding, extract or infer: sourceUrl, platform, date, authorContext, problemDescribed, currentSolution, frustrationLevel, wtpSignal, relevantQuotes, engagementScore. Sort all findings by engagementScore (upvotes/score) descending. Take top 30. Filter out any URLs appearing in watchdog-blocklist.json. Include as top-level `rawFindings` array in report.json.

## Inline Citations (Bibliography System)

Build a research-paper style citation system throughout the report:

1. **Collect all citations** from synthesis files into a deduplicated numbered bibliography. Every evidence entry with a URL becomes a citation. Assign sequential IDs starting from 1.

2. **Add a top-level `citations` array** (the bibliography):
```json
"citations": [
  {
    "id": 1,
    "url": "https://reddit.com/r/.../...",
    "source": "reddit",
    "sourceType": "user-complaint|wtp-signal|feature-request|market-discussion|competitor-review",
    "title": "Thread or page title",
    "date": "2026-01-15",
    "quote": "Exact quote used as evidence",
    "retrievedAt": "<ISO timestamp>",
    "context": "Brief description of what this citation supports"
  }
]
```

3. **Inject `citationIds` arrays** into every evidence-bearing field throughout the report:
   - Pain themes: `"citationIds": [1, 3, 7]`
   - Opportunities: `"citationIds": [2, 5, 8]`
   - Switching signals: `"citationIds": [4, 9]`
   - Unmet needs: `"citationIds": [6, 10]`
   - Executive summary claims: `"citationIds": [1, 2, 3]`

4. **Use inline [N] notation** in human-readable evidence strings:
   - `"evidence": "Users report 2-3 week response times [1][3][7]"`

5. **Add `citationStats`** to report metadata:
```json
"citationStats": {
  "total": N,
  "bySource": { "reddit": N, "hackernews": N, "trustpilot": N, ... },
  "goldTierCitations": N
}
```

6. **Deduplication**: If the same URL appears in multiple synthesis files, it gets ONE citation ID. Map all references to that single ID.

## Citation Pipeline — MANDATORY

The citation bibliography is the MOST IMPORTANT part of the report. A report without verifiable citations is worthless. Follow these steps EXACTLY:

### Step 1: Build Citation Index from Scan Data
Before writing any report content, scan ALL input files and extract every unique URL:
- From scan-*.json: every post/evidence `url` field
- From synthesis-*.json: every evidence item's `url` field
- From deep-research-verification-round-*.json: every `newEvidence[].url`
- From community-validation.json: every community/thread URL

Deduplicate by URL. Assign sequential citation IDs starting from 1.

### Step 2: Inject citationIds Everywhere
Every claim, statistic, or evidence reference in the report MUST have a `citationIds` array pointing to the bibliography. If a claim has no citation, either find one or mark it as `"citationStatus": "UNCITED"`.

### Step 3: Build the citations Array
The top-level `citations` array MUST contain every unique URL used in the report. Schema per entry:
```json
{
  "id": 1,
  "url": "https://...",
  "source": "hackernews|github|reddit|websearch|producthunt|trustpilot|arxiv|rfc",
  "title": "Page or thread title",
  "date": "2026-03-28",
  "quote": "Key quote from this source (if applicable)",
  "context": "What this citation supports in the report"
}
```

### Step 4: Verify Completeness
Before writing the file, verify:
- Every opportunity has citationIds
- Every pain theme has citationIds
- Every switching signal has citationIds
- Every competitor has at least a website URL
- citationStats.total matches citations array length

## Output

Write to: `/tmp/gapscout-<scan-id>/report.json`

```json
{
  "reportVersion": "3.0",
  "generatedAt": "<ISO timestamp>",
  "scanId": "<scan-id>",
  "market": "<market name>",
  "executiveSummary": {
    "marketOverview": "<1-2 sentences>",
    "topOpportunities": [
      { "rank": 1, "gap": "<name>", "score": <N>, "verdict": "<verdict>", "citationIds": [1, 2, 3] }
    ],
    "keyFinding": "<most surprising insight>",
    "totalCompetitors": <N>,
    "totalGapsIdentified": <N>,
    "validatedOpportunities": <N>
  },
  "competitiveMap": { },
  "painAnalysis": { },
  "unmetNeeds": { },
  "switchingSignals": { },
  "gapMatrix": { },
  "opportunities": [ ],
  "rescueFindings": { },
  "signalStrength": { },
  "counterPositioning": { },
  "consolidationForecast": { },
  "founderProfiles": { },
  "marketSizing": { },
  "causalChains": { },
  "strategicNarrative": { },
  "citations": [
    { "id": 1, "url": "<url>", "source": "<source>", "sourceType": "<type>", "quote": "<quote>", "date": "<date>", "context": "<context>" }
  ],
  "citationStats": {
    "total": "<N>",
    "bySource": { "reddit": "<N>", "hackernews": "<N>" },
    "goldTierCitations": "<N>"
  },
  "communityValidation": {
    "opportunities": [
      {
        "gap": "<name>",
        "communities": [
          { "platform": "<reddit|discord|hn|forum>", "name": "<name>", "url": "<url>", "relevance": "<1-5>", "activity": "<1-5>", "whyRelevant": "<reason>" }
        ],
        "validationPlan": { "surveyQuestion": "<question>", "engagementTemplate": "<template>", "whatToLookFor": [], "redFlags": [] }
      }
    ],
    "crossCuttingCommunities": []
  },
  "networkReach": {
    "summary": {
      "totalConnectionsIndexed": "<N>",
      "teamMembersIndexed": "<N>",
      "competitorConnections": "<N>",
      "personaMatches": "<N>",
      "opportunitiesWithCoverage": "<N>/<total>"
    },
    "perOpportunity": [
      {
        "gap": "<name>",
        "totalRelevantConnections": "<N>",
        "competitorConnections": "<N>",
        "personaMatches": "<N>",
        "topConnections": [
          {
            "name": "Jane Doe",
            "company": "Acme Corp",
            "position": "VP of Product",
            "connectedVia": ["mike", "sarah"],
            "matchType": "persona_match",
            "suggestedOutreach": "<what to ask>"
          }
        ],
        "teamMembersToActivate": ["mike", "sarah"]
      }
    ]
  },
  "deepResearchVerification": {
    "roundsCompleted": N,
    "converged": true/false,
    "adjustedOpportunities": [
      {
        "gap": "<name>",
        "originalScore": N,
        "finalAdjustedScore": N,
        "totalScoreChange": N,
        "finalVerdict": "STRENGTHENED|UNCHANGED|WEAKENED|INVALIDATED",
        "finalConfidence": "HIGH|MEDIUM|LOW",
        "newEvidenceCount": N,
        "verificationSummary": "<1-2 sentences>"
      }
    ],
    "invalidatedOpportunities": ["<gap names that were removed>"],
    "totalNewEvidence": N
  },
  "deltaSummary": {
    "previousScanId": "<id>",
    "narrativeSummary": "<2-3 paragraphs>",
    "opportunityDelta": [],
    "competitorDelta": {},
    "stats": {}
  },
  "rawFindings": [
    {
      "sourceUrl": "https://exact-source-url",
      "platform": "hackernews|reddit|trustpilot|producthunt|websearch",
      "date": "2026-03-28",
      "authorContext": "developer|founder|enterprise|hobbyist|unknown",
      "problemDescribed": "1-2 sentence description of the problem or complaint",
      "currentSolution": "what the author is currently using (null if not mentioned)",
      "frustrationLevel": "mild|blocker|showstopper",
      "wtpSignal": "any price/budget/willingness-to-pay mention (null if none)",
      "relevantQuotes": ["exact quote from the post"],
      "engagementScore": "<number — upvotes/score/points from the platform>"
    }
  ],
  "topDemandSignals": [
    {
      "rank": 1,
      "sourceUrl": "<direct URL to the source post/review>",
      "platform": "reddit|hn|trustpilot|producthunt|websearch",
      "date": "YYYY-MM-DD",
      "specificity": "high|medium|low",
      "painLevel": "showstopper|blocker|mild",
      "engagementScore": "<N — upvotes/score/points>",
      "summary": "one-line description of the demand signal",
      "quote": "exact user words expressing demand",
      "demandType": "<categorization of what the user needs>"
    }
  ],
  "positioningRecommendation": {
    "targetPersona": "who specifically to sell to (e.g., 'AI agent developers building autonomous account creation workflows')",
    "positioning": "how to position the product (e.g., 'Compliant real-SIM verification API for AI agents')",
    "differentiator": "what makes it different from existing solutions",
    "priceRange": "recommended pricing based on WTP signals",
    "goCommunity": "where to find early users (specific subreddits, Discord servers, HN threads)",
    "antiPositioning": "what NOT to be (e.g., 'not a SIM farm, not a gray-market verifier')",
    "evidenceBasis": "which findings support this positioning"
  },
  "dataQuality": {
    "qaVerdict": "<PASS|MARGINAL|FAIL>",
    "compositeScore": <N>,
    "notes": ["<key QA findings>"]
  }
}
```

## Rules

- Do the work yourself — do NOT spawn sub-agents
- Write output to the specified file path
- Include ALL data from synthesis files — this is the canonical report
- Every claim in the executive summary must be traceable to synthesis data
- If synthesis files are missing, include what exists and note gaps
- If input files are missing, report error — do not hallucinate data
- **CITATION BLOCKLIST ENFORCEMENT**: If `watchdog-blocklist.json` exists, strip any URL appearing in `blockedCitations` from the final report. Replace with `"citationStatus": "REMOVED_BY_WATCHDOG"`. Report total removed count in `dataQuality.blockedCitationsRemoved`.
- **SCHEMA STANDARDIZATION**: All synthesis sprint data MUST use these canonical sub-key names in the report: `painThemes` (not `painPoints` or `pains`), `unmetNeeds` (not `needs` or `gaps`), `switchingSignals` (not `switches` or `migrations`), `opportunities` (not `gaps` or `ideas`). If a synthesis file uses a variant name, map it to the canonical name.
- **NETWORK REACH**: If `connection-index.json` does not exist, set `networkReach` to `null` in the report. Do not fabricate connection data.
- **RAW FINDINGS EXTRACTION**: Read all scan-*.json files. Extract individual posts from `rawPosts` (HN, Reddit), `rawProducts` (PH), `competitors.*.painPosts` (Trustpilot), and `painThemes[].evidence` (all sources). For each post, populate: `sourceUrl` from `url`, `platform` from `source`/filename, `date` from `date`, `authorContext` from `authorContext` field (default "unknown" if missing), `problemDescribed` from `theme`+`quote`, `currentSolution` inferred from post content (null if not mentioned), `frustrationLevel` from `frustrationLevel` field (default "mild" if missing), `wtpSignal` from `wtpSignal` field (null if missing), `relevantQuotes` from `quote`, `engagementScore` from `score`/`upvotes`/`points`. Sort by engagementScore descending. Take top 30. Filter out blocklisted URLs.
