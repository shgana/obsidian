import { buildContextGraph } from "../src/graphBuilder";
import { DEFAULT_SETTINGS } from "../src/settings";
import type {
  AIProvider,
  CanonicalNodeSeed,
  ConversationExtraction,
  ExtractedContext,
  ParsedConversation,
  ReviewQueueSeed
} from "../src/types";

const provider: AIProvider = {
  async extractContext(): Promise<ExtractedContext> {
    throw new Error("not used");
  },
  async embedText(text: string): Promise<number[]> {
    if (text.toLowerCase().includes("obsidian")) {
      return [1, 0, 0];
    }

    return [0, 1, 0];
  },
  async synthesizeSummary(): Promise<string> {
    return "";
  }
};

describe("context graph builder", () => {
  it("uses moderate default graph-density caps", () => {
    expect(DEFAULT_SETTINGS.maxCoOccurrenceLinksPerType).toBe(2);
    expect(DEFAULT_SETTINGS.maxSimilarityLinksPerType).toBe(2);
  });

  it("creates conservative typed nodes and source-to-node edges", async () => {
    const graph = await buildContextGraph(
      [
        extractionInput("conv-1", "Graph UI", "Obsidian", 0.91),
        extractionInput("conv-2", "Agent memory", "Obsidian.md", 0.88)
      ],
      DEFAULT_SETTINGS,
      provider
    );

    const topicNodes = graph.nodes.filter((node) => node.type === "topic");
    expect(topicNodes).toHaveLength(1);
    expect(topicNodes[0].sourceIds).toEqual(["conv-1", "conv-2"]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.every((edge) => edge.edgeType === "evidence_for")).toBe(true);
  });

  it("filters low-confidence items", async () => {
    const graph = await buildContextGraph(
      [extractionInput("conv-low", "Weak note", "Speculative Topic", 0.4)],
      DEFAULT_SETTINGS,
      provider
    );

    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it("does not promote medium-confidence single-source items", async () => {
    const graph = await buildContextGraph(
      [extractionInput("conv-medium", "Medium note", "Medium Topic", 0.82)],
      DEFAULT_SETTINGS,
      provider
    );

    expect(graph.nodes).toHaveLength(0);
  });

  it("adds one source anchor fallback for an otherwise unlinked named entity in a durable conversation", async () => {
    const input = extractionInput(
      "conv-residency",
      "Residency startup application notes",
      "small talk",
      0.4
    );
    input.extraction.topics = [];
    input.extraction.entities = [
      graphItem(
        "The Residency",
        "A startup incubator program discussed by the user.",
        0.76
      )
    ];

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider);
    const entities = graph.nodes.filter((node) => node.type === "entity");

    expect(entities).toHaveLength(1);
    expect(entities[0].label).toBe("The Residency");
    expect(graph.sourceLinksById["conv-residency"].entity?.[0].label).toBe("The Residency");
    expect(graph.stats.sourceAnchorFallbacks).toBe(1);
    expect(graph.stats.underlinkedSources).toBe(1);
  });

  it("suppresses source anchor fallback promotion for transactional conversations", async () => {
    const input = extractionInput("conv-greeting", "Greetings exchange", "small talk", 0.4);
    input.extraction.topics = [];
    input.extraction.entities = [
      graphItem(
        "The Residency",
        "A startup incubator program discussed by the user.",
        0.76
      )
    ];

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider);

    expect(graph.nodes).toHaveLength(0);
    expect(graph.stats.sourceAnchorFallbacks).toBe(0);
    expect(graph.stats.underlinkedSources).toBe(1);
    expect(graph.stats.demotedCandidates).toBeGreaterThanOrEqual(1);
  });

  it("does not add source anchor fallback for weak or unnamed context", async () => {
    const input = extractionInput("conv-weak-anchor", "Weak anchor", "small talk", 0.4);
    input.extraction.topics = [];
    input.extraction.entities = [
      graphItem(
        "application process",
        "A generic application-process reference without a stable named anchor.",
        0.76
      )
    ];

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider);

    expect(graph.nodes).toHaveLength(0);
    expect(graph.sourceLinksById["conv-weak-anchor"].entity || []).toHaveLength(0);
    expect(graph.stats.sourceAnchorFallbacks).toBe(0);
    expect(graph.stats.underlinkedSources).toBe(1);
  });

  it("does not add source anchor fallback when a source already has a canonical link", async () => {
    const input = extractionInput("conv-linked-anchor", "Linked anchor", "small talk", 0.4);
    input.extraction.topics = [];
    input.extraction.entities = [
      graphItem(
        "OpenAIService.swift",
        "A stable Swift source file referenced in the conversation.",
        0.99
      ),
      graphItem(
        "The Residency",
        "A startup incubator program discussed by the user.",
        0.76
      )
    ];

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider);
    const artifactLabels = graph.nodes.filter((node) => node.type === "artifact").map((node) => node.label);

    expect(artifactLabels).toEqual(["OpenAIService.swift"]);
    expect(graph.stats.sourceAnchorFallbacks).toBe(0);
    expect(graph.stats.underlinkedSources).toBe(0);
  });

  it("does not use projects or tasks as source anchor fallbacks", async () => {
    const input = extractionInput("conv-task-anchor", "Task anchor", "small talk", 0.4);
    input.extraction.topics = [];
    input.extraction.projects = [
      graphItem(
        "The Residency prep project",
        "Prepare for The Residency interview process.",
        0.96
      )
    ];
    input.extraction.tasks = [
      graphItem(
        "Research The Residency prep tips",
        "Research preparation tips for The Residency.",
        0.96
      )
    ];

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider);

    expect(graph.nodes).toHaveLength(0);
    expect(graph.stats.sourceAnchorFallbacks).toBe(0);
    expect(graph.stats.underlinkedSources).toBe(1);
  });

  it("removes chunk markers from canonical labels", async () => {
    const graph = await buildContextGraph(
      [extractionInput("conv-chunk", "AI Scan Accuracy Improvement", "AI Scan Accuracy Improvement (chunk 2)", 0.99)],
      DEFAULT_SETTINGS,
      provider
    );

    expect(graph.nodes[0].label).toBe("AI Scan Accuracy Improvement");
    expect(graph.nodes[0].path).not.toContain("chunk");
  });

  it("adds typed related context links from projects", async () => {
    const input = extractionInput("conv-project", "Project note", "Obsidian", 0.95);
    input.extraction.projects = [
      {
        label: "Personal context graph",
        summary: "A project to build a context graph.",
        confidence: 0.95,
        evidence: [
          {
            quote: "Build a personal context graph.",
            turnRole: "user",
            confidence: 0.95
          }
        ]
      }
    ];
    input.extraction.tasks = [
      {
        label: "Import ChatGPT data",
        summary: "Import ChatGPT data into Obsidian.",
        confidence: 0.94,
        evidence: [
          {
            quote: "Import ChatGPT data.",
            turnRole: "user",
            confidence: 0.94
          }
        ]
      }
    ];

    const graph = await buildContextGraph(
      [input],
      { ...DEFAULT_SETTINGS, minimumCanonicalSources: 1 },
      provider
    );
    const project = graph.nodes.find((node) => node.type === "project");

    expect(project).toBeDefined();
    expect(graph.nodeLinksById[project!.id].task?.[0].label).toBe("Import ChatGPT data");
    expect(graph.edges.every((edge) => edge.edgeType === "evidence_for")).toBe(true);
  });

  it("adds symmetric reverse links from co-occurring tasks back to their project", async () => {
    const input = extractionInput("conv-symmetric", "Symmetric note", "Obsidian", 0.95);
    input.extraction.projects = [
      {
        label: "Personal context graph",
        summary: "A project to build a context graph.",
        confidence: 0.95,
        evidence: [
          { quote: "Build a personal context graph.", turnRole: "user", confidence: 0.95 }
        ]
      }
    ];
    input.extraction.tasks = [
      {
        label: "Import ChatGPT data",
        summary: "Import ChatGPT data into Obsidian.",
        confidence: 0.94,
        evidence: [
          { quote: "Import ChatGPT data.", turnRole: "user", confidence: 0.94 }
        ]
      }
    ];

    const graph = await buildContextGraph(
      [input],
      { ...DEFAULT_SETTINGS, minimumCanonicalSources: 1 },
      provider
    );

    const task = graph.nodes.find((node) => node.type === "task");
    const project = graph.nodes.find((node) => node.type === "project");

    expect(task).toBeDefined();
    expect(project).toBeDefined();
    expect(graph.nodeLinksById[task!.id].project?.[0].id).toBe(project!.id);
    expect(graph.nodeLinksById[task!.id].topic?.[0].label).toBe("Obsidian");
  });

  it("adds similarity links between semantically close nodes that never co-occurred", async () => {
    const labelEmbeddings: Record<string, number[]> = {
      neighborhood: [1, 0, 0],
      "neighbourhood network": [0.8, 0.6, 0],
      "local community graph": [0.8, 0, 0.6],
      "resident network map": [0.7, 0, 0.714],
      unrelated: [0, 0, 1]
    };

    const similarityProvider: AIProvider = {
      async extractContext(): Promise<ExtractedContext> {
        throw new Error("not used");
      },
      async embedText(text: string): Promise<number[]> {
        const lower = text.toLowerCase();
        for (const [needle, vector] of Object.entries(labelEmbeddings)) {
          if (lower.includes(needle)) {
            return vector;
          }
        }
        return [0, 1, 0];
      },
      async synthesizeSummary(): Promise<string> {
        return "";
      }
    };

    const settings = { ...DEFAULT_SETTINGS, minimumCanonicalSources: 1 };
    const graph = await buildContextGraph(
      [
        extractionInput("conv-a", "Conversation A", "neighborhood", 0.95),
        extractionInput("conv-b", "Conversation B", "neighbourhood network", 0.95),
        extractionInput("conv-d", "Conversation D", "local community graph", 0.95),
        extractionInput("conv-e", "Conversation E", "resident network map", 0.95),
        extractionInput("conv-c", "Conversation C", "unrelated", 0.95)
      ],
      settings,
      similarityProvider
    );

    const neighborhood = graph.nodes.find((node) => node.label === "neighborhood");
    const network = graph.nodes.find((node) => node.label === "neighbourhood network");
    const unrelated = graph.nodes.find((node) => node.label === "unrelated");

    expect(neighborhood).toBeDefined();
    expect(network).toBeDefined();
    expect(unrelated).toBeDefined();

    const neighborhoodLinks = graph.nodeLinksById[neighborhood!.id]?.topic || [];
    expect(neighborhoodLinks).toHaveLength(2);
    expect(neighborhoodLinks.some((node) => node.id === network!.id)).toBe(true);
    expect(neighborhoodLinks.some((node) => node.id === unrelated!.id)).toBe(false);
  });

  it("redirects filename-labeled entity candidates into the matching artifact", async () => {
    const input = extractionInput(
      "conv-filename-merge",
      "BodyScanner work notes",
      "scanner",
      0.95
    );
    input.extraction.entities = [
      graphItem("OpenAIService.swift", "Service file used in the iOS app.", 0.98)
    ];
    input.extraction.artifacts = [
      graphItem(
        "OpenAIService.swift implementation",
        "Implementation of the service file.",
        0.97
      )
    ];

    const graph = await buildContextGraph(
      [input],
      { ...DEFAULT_SETTINGS, minimumCanonicalSources: 1 },
      provider
    );

    const filenameNodes = graph.nodes.filter((node) =>
      /^openaiservice\.swift/i.test(node.label)
    );
    const artifactNodes = graph.nodes.filter((node) => node.type === "artifact");

    expect(filenameNodes).toHaveLength(1);
    expect(filenameNodes[0].type).toBe("artifact");
    expect(artifactNodes).toHaveLength(1);
  });

  it("suppresses canonical node promotion for transactional conversations", async () => {
    const input = extractionInput(
      "conv-transactional",
      "Git checkout explanation",
      "git checkout",
      0.99
    );
    input.extraction.entities = [
      graphItem("Git", "Version control system the user asked about.", 0.98)
    ];

    const graph = await buildContextGraph(
      [input],
      { ...DEFAULT_SETTINGS, minimumCanonicalSources: 1 },
      provider
    );

    expect(graph.nodes.filter((node) => node.type === "entity")).toHaveLength(0);
    expect(graph.stats.demotedCandidates).toBeGreaterThanOrEqual(1);
  });

  it("still promotes canonical nodes when transactional content recurs across non-transactional conversations", async () => {
    const transactionalInput = extractionInput(
      "conv-trx",
      "How to configure GitHub",
      "github",
      0.98
    );
    transactionalInput.extraction.entities = [
      graphItem("GitHub", "Hosting platform the user uses.", 0.98)
    ];

    const durableInput = extractionInput(
      "conv-durable",
      "Project repo cleanup",
      "github",
      0.98
    );
    durableInput.extraction.entities = [
      graphItem("GitHub", "Hosting platform the user uses.", 0.98)
    ];

    const graph = await buildContextGraph(
      [transactionalInput, durableInput],
      DEFAULT_SETTINGS,
      provider
    );

    const github = graph.nodes.find((node) => node.label === "GitHub");
    expect(github).toBeDefined();
    expect(github!.sourceIds.sort()).toEqual(["conv-durable", "conv-trx"]);
  });

  it("calls summary synthesis for nodes with sufficient evidence", async () => {
    const synthesizedLabels: string[] = [];
    const synthProvider: AIProvider = {
      async extractContext(): Promise<ExtractedContext> {
        throw new Error("not used");
      },
      async embedText(): Promise<number[]> {
        return [1, 0, 0];
      },
      async synthesizeSummary(args): Promise<string> {
        synthesizedLabels.push(args.label);
        return `Synthesized summary for ${args.label}.`;
      }
    };

    const seedItem = {
      label: "Obsidian",
      summary: "Initial summary.",
      confidence: 0.96,
      evidence: [
        { quote: "Use Obsidian for memory.", turnRole: "user" as const, confidence: 0.96 }
      ]
    };

    const inputA = extractionInput("conv-syn-a", "A", "ignored", 0.96);
    inputA.extraction.topics = [seedItem];
    const inputB = extractionInput("conv-syn-b", "B", "ignored", 0.95);
    inputB.extraction.topics = [
      { ...seedItem, evidence: [{ quote: "Obsidian is the graph UI.", turnRole: "user", confidence: 0.95 }] }
    ];
    const inputC = extractionInput("conv-syn-c", "C", "ignored", 0.94);
    inputC.extraction.topics = [
      { ...seedItem, evidence: [{ quote: "Stick with Obsidian.", turnRole: "user", confidence: 0.94 }] }
    ];

    const graph = await buildContextGraph(
      [inputA, inputB, inputC],
      { ...DEFAULT_SETTINGS, synthesizeNodeSummaryMinEvidence: 3 },
      synthProvider
    );

    const obsidian = graph.nodes.find((node) => node.label === "Obsidian");
    expect(obsidian).toBeDefined();
    expect(synthesizedLabels).toContain("Obsidian");
    expect(obsidian!.summary).toBe("Synthesized summary for Obsidian.");
  });

  it("uses batch summary synthesis when the provider supports it", async () => {
    let batchCalls = 0;
    let individualCalls = 0;
    const batchProvider: AIProvider = {
      ...provider,
      async synthesizeSummary(): Promise<string> {
        individualCalls += 1;
        return "Individual summary.";
      },
      async synthesizeSummariesBatch(args): Promise<Array<{ key: string; summary: string }>> {
        batchCalls += 1;
        return args.map((arg) => ({
          key: arg.key || arg.label,
          summary: `Batch summary for ${arg.label}.`
        }));
      }
    };

    const seedItem = {
      label: "Obsidian",
      summary: "Initial summary.",
      confidence: 0.96,
      evidence: [
        { quote: "Use Obsidian for memory.", turnRole: "user" as const, confidence: 0.96 }
      ]
    };
    const inputs = ["a", "b", "c"].map((suffix) => {
      const input = extractionInput(`conv-batch-${suffix}`, suffix, "ignored", 0.96);
      input.extraction.topics = [
        {
          ...seedItem,
          evidence: [
            {
              quote: `Obsidian evidence ${suffix}.`,
              turnRole: "user" as const,
              confidence: 0.96
            }
          ]
        }
      ];
      return input;
    });

    const graph = await buildContextGraph(
      inputs,
      { ...DEFAULT_SETTINGS, synthesizeNodeSummaryMinEvidence: 3 },
      batchProvider
    );

    expect(batchCalls).toBe(1);
    expect(individualCalls).toBe(0);
    expect(graph.nodes.find((node) => node.label === "Obsidian")?.summary).toBe(
      "Batch summary for Obsidian."
    );
  });

  it("falls back to individual summary synthesis when batch synthesis fails", async () => {
    let individualCalls = 0;
    const fallbackProvider: AIProvider = {
      ...provider,
      async synthesizeSummary(args): Promise<string> {
        individualCalls += 1;
        return `Fallback summary for ${args.label}.`;
      },
      async synthesizeSummariesBatch(): Promise<Array<{ key: string; summary: string }>> {
        throw new Error("batch unavailable");
      }
    };

    const inputs = ["a", "b", "c"].map((suffix) => {
      const input = extractionInput(`conv-fallback-${suffix}`, suffix, "ignored", 0.96);
      input.extraction.topics = [
        {
          label: "Obsidian",
          summary: "Initial summary.",
          confidence: 0.96,
          evidence: [
            {
              quote: `Obsidian evidence ${suffix}.`,
              turnRole: "user" as const,
              confidence: 0.96
            }
          ]
        }
      ];
      return input;
    });

    const graph = await buildContextGraph(
      inputs,
      { ...DEFAULT_SETTINGS, synthesizeNodeSummaryMinEvidence: 3 },
      fallbackProvider
    );

    expect(individualCalls).toBe(1);
    expect(graph.nodes.find((node) => node.label === "Obsidian")?.summary).toBe(
      "Fallback summary for Obsidian."
    );
    expect(graph.warnings.some((warning) => warning.includes("Batch summary synthesis failed"))).toBe(true);
  });

  it("absorbs medium-confidence items into existing seeded canonical nodes", async () => {
    const seed: CanonicalNodeSeed = {
      type: "topic",
      id: "topic_obsidian",
      label: "Obsidian",
      slug: "obsidian",
      aliases: [],
      path: "Context Graph/Topics/Obsidian.md",
      summary: "Obsidian is the graph UI.",
      confidence: 0.94,
      evidence: [],
      sourceIds: ["seed-source"]
    };

    const graph = await buildContextGraph(
      [extractionInput("conv-medium", "Medium note", "Obsidian.md", 0.82)],
      DEFAULT_SETTINGS,
      provider,
      [seed]
    );

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].label).toBe("Obsidian");
    expect(graph.nodes[0].aliases).toContain("Obsidian.md");
    expect(graph.nodes[0].sourceIds).toContain("conv-medium");
    expect(graph.stats.mergedCandidates).toBe(1);
  });

  it("promotes repeated medium-confidence clusters but keeps single medium items source-only", async () => {
    const repeatedGraph = await buildContextGraph(
      [
        extractionInput("conv-a", "A", "Semantic topic", 0.82),
        extractionInput("conv-b", "B", "Semantic topic", 0.81)
      ],
      DEFAULT_SETTINGS,
      provider
    );
    const singleGraph = await buildContextGraph(
      [extractionInput("conv-c", "C", "One-off topic", 0.82)],
      DEFAULT_SETTINGS,
      provider
    );

    expect(repeatedGraph.nodes).toHaveLength(1);
    expect(repeatedGraph.nodes[0].sourceIds).toEqual(["conv-a", "conv-b"]);
    expect(singleGraph.nodes).toHaveLength(0);
    expect(singleGraph.stats.sourceOnlyCandidates).toBe(1);
  });

  it("prunes duplicate seeded canonical nodes by merging aliases and evidence", async () => {
    const seeds: CanonicalNodeSeed[] = [
      seed("topic", "AI scan evaluation", 0.92, ["conv-1"]),
      seed("topic", "AI scan evaluation", 0.95, ["conv-2"])
    ];

    const graph = await buildContextGraph(
      [extractionInput("conv-3", "Current scan note", "AI scan evaluation", 0.82)],
      DEFAULT_SETTINGS,
      provider,
      seeds
    );

    expect(graph.nodes).toHaveLength(1);
    // Singleton-type group is anchored at 0.85 after rank-based rescaling;
    // the merge still preserves the higher source confidence on per-evidence entries.
    expect(graph.nodes[0].confidence).toBe(0.85);
    expect(graph.nodes[0].sourceIds.sort()).toEqual(["conv-1", "conv-2", "conv-3"]);
    expect(graph.stats.seededNodes).toBe(1);
    expect(graph.stats.prunedDuplicateNodes).toBe(1);
  });

  it("uses unmatched seed nodes for matching only and omits them from visible graph drafts", async () => {
    const graph = await buildContextGraph(
      [],
      DEFAULT_SETTINGS,
      provider,
      [seed("topic", "Old topic island", 0.95, ["old-conv"])]
    );

    expect(graph.nodes).toHaveLength(0);
    expect(graph.stats.seededNodes).toBe(0);
    expect(graph.stats.unmatchedSeedNodes).toBe(1);
    expect(graph.stats.visibleCanonicalNodes).toBe(0);
  });

  it("consolidates project variants into a durable project survivor", async () => {
    const input = extractionInput("conv-project-variants", "AI Accuracy Improvement", "placeholder", 0.8);
    input.extraction.topics = [];
    input.extraction.projects = [
      graphItem(
        "BodyScanner fitness AI feature",
        "BodyScanner uses scan evaluation and workout generation for fitness analysis.",
        0.99
      ),
      graphItem(
        "AI scan evaluation improvement project",
        "Improve Scann AI body scan evaluation and workout generation.",
        0.98
      )
    ];

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider);
    const projects = graph.nodes.filter((node) => node.type === "project");
    const projectLabels = [projects[0]?.label, ...(projects[0]?.aliases || [])];

    expect(projects).toHaveLength(1);
    expect(projectLabels).toContain("AI scan evaluation improvement project");
    expect(projectLabels).toContain("BodyScanner fitness AI feature");
    expect(graph.sourceLinksById["conv-project-variants"].project).toHaveLength(1);
  });

  it("merges app and product label variants with lightweight app-product normalization", async () => {
    const input = extractionInput("conv-app-product", "AI learning app notes", "placeholder", 0.4);
    input.extraction.topics = [
      graphItem(
        "AiLingo AI-learning app",
        "A product concept for an AI learning app.",
        0.99
      )
    ];
    const secondInput = extractionInput(
      "conv-app-product-2",
      "AI learning app product notes",
      "placeholder",
      0.4
    );
    secondInput.extraction.topics = [
      graphItem(
        "AI learning app product design",
        "Product design work for the AI learning app.",
        0.98
      )
    ];

    const graph = await buildContextGraph([input, secondInput], DEFAULT_SETTINGS, provider);
    const topics = graph.nodes.filter((node) => node.type === "topic");
    const labels = [topics[0]?.label, ...(topics[0]?.aliases || [])];

    expect(topics).toHaveLength(1);
    expect(labels).toContain("AiLingo AI-learning app");
    expect(labels).toContain("AI learning app product design");
    expect(graph.sourceLinksById["conv-app-product"].topic).toHaveLength(1);
    expect(graph.sourceLinksById["conv-app-product-2"].topic).toHaveLength(1);
  });

  it("does not match non-project phone-plan candidates to stale Duolingo seed aliases", async () => {
    const duolingoSeed = seed("project", "Duolingo-style AI learning app", 0.99, ["old-duo"]);
    duolingoSeed.summary = "A durable app project for learning AI with Duolingo-style gamification.";
    duolingoSeed.aliases = ["Choosing a family phone plan", "AI/Duolingo-style app"];

    const input = projectInput("conv-phone", "Family Plan iPhone Deals", [
      graphItem(
        "Choosing a family phone plan",
        "Compare Verizon, T-Mobile, and AT&T carrier family plans with free iPhone offers.",
        0.99
      )
    ]);

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider, [duolingoSeed]);

    expect(graph.nodes.filter((node) => node.type === "project")).toHaveLength(0);
    expect(graph.sourceLinksById["conv-phone"].project || []).toHaveLength(0);
    expect(graph.stats.rejectedProjectCandidates).toBe(1);
    expect(graph.stats.filteredSeedAliases).toBe(1);
  });

  it("rebuilds activated project seed metadata from current compatible evidence", async () => {
    const duolingoSeed = seed("project", "Duolingo-style AI learning app", 0.99, ["old-phone"]);
    duolingoSeed.summary = "A durable app project for learning AI with Duolingo-style gamification.";
    duolingoSeed.aliases = ["Choosing a family phone plan", "AI/Duolingo-style app"];
    duolingoSeed.evidence = [
      {
        sourceId: "old-phone",
        sourceTitle: "Family Plan iPhone Deals",
        sourcePath: "Context Graph/Sources/ChatGPT/Family Plan iPhone Deals.md",
        quote: "family plans that give me a free iPhone per line",
        confidence: 0.98
      }
    ];

    const input = projectInput("conv-duo", "Tech Stack for AI App", [
      graphItem(
        "AI/Duolingo-style app",
        "Build a Duolingo-style app for learning AI concepts with gamification.",
        0.99
      )
    ]);

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider, [duolingoSeed]);
    const project = graph.nodes.find((node) => node.type === "project");

    expect(project?.label).toBe("Duolingo-style AI learning app");
    expect(project?.aliases).toContain("AI/Duolingo-style app");
    expect(project?.aliases).not.toContain("Choosing a family phone plan");
    expect(project?.sourceIds).toEqual(["conv-duo"]);
    expect(project?.evidence.map((entry) => entry.sourceId)).toEqual(["conv-duo"]);
  });

  it("attaches project-domain evidence to an existing durable project without alias promotion", async () => {
    const scannSeed = seed("project", "AI scan evaluation improvement project", 0.99, ["old-scann"]);
    scannSeed.summary = "A durable Scann project for scan evaluation, benchmarking, and workout generation.";

    const input = projectInput("conv-deck", "Funding Breakdown & Pitch Deck", [
      graphItem(
        "Funding breakdown & pitch deck for Scann",
        "Create pitch deck sections and funding ask for the Scann fitness scan product.",
        0.97
      )
    ]);

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider, [scannSeed]);
    const project = graph.nodes.find((node) => node.type === "project");

    expect(project?.label).toBe("Scann / Scanis");
    expect(project?.aliases).not.toContain("Funding breakdown & pitch deck for Scann");
    expect(project?.sourceIds).toEqual(["conv-deck"]);
    expect(graph.sourceLinksById["conv-deck"].project?.[0].label).toBe("Scann / Scanis");
    expect(graph.stats.projectEvidenceCandidates).toBe(1);
  });

  it("treats UX project labels as evidence for the durable AI learning app instead of separate projects", async () => {
    const duolingoSeed = seed("project", "Duolingo-style AI learning app", 0.99, ["old-duo"]);
    duolingoSeed.summary = "A durable app project for learning AI with Duolingo-style gamification.";

    const input = projectInput("conv-ux", "Duolingo Product Success Analysis", [
      graphItem(
        "AI learning app UX design",
        "Analyze Duolingo onboarding and UX flow for the AI learning app.",
        0.99
      )
    ]);

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider, [duolingoSeed]);
    const projects = graph.nodes.filter((node) => node.type === "project");

    expect(projects).toHaveLength(1);
    expect(projects[0].label).toBe("Duolingo-style AI learning app");
    expect(projects[0].aliases).not.toContain("AI learning app UX design");
    expect(graph.sourceLinksById["conv-ux"].project?.[0].label).toBe("Duolingo-style AI learning app");
    expect(graph.stats.projectEvidenceCandidates).toBe(1);
  });

  it("caps visible source links per type", async () => {
    const input = extractionInput("conv-many", "Many topics", "Topic 0", 0.96);
    input.extraction.topics = Array.from({ length: 5 }, (_, index) => ({
      label: `Topic ${index}`,
      summary: `Topic ${index} summary.`,
      confidence: 0.98 - index * 0.005,
      evidence: [
        {
          quote: `Topic ${index} evidence.`,
          turnRole: "user",
          confidence: 0.98 - index * 0.005
        }
      ]
    }));

    const graph = await buildContextGraph(
      [input],
      { ...DEFAULT_SETTINGS, minimumCanonicalSources: 1, maxSourceLinksPerType: 2 },
      {
        ...provider,
        async embedText(text: string): Promise<number[]> {
          const index = Number.parseInt(/Topic (\d)/.exec(text)?.[1] || "0", 10);
          return Array.from({ length: 5 }, (_, vectorIndex) => (vectorIndex === index ? 1 : 0));
        }
      }
    );

    expect(graph.nodes).toHaveLength(2);
    expect(graph.sourceLinksById["conv-many"].topic).toHaveLength(2);
    expect(graph.stats.sourceOnlyCandidates).toBe(3);
    expect(graph.stats.isolatedCanonicalNodes).toBe(0);
  });

  it("rescales confidence by rank within each node type so signal spreads across 0.55-0.99", async () => {
    // Three topics in one conversation: one with rich evidence, one with one quote, one with one quote.
    const input = extractionInput("conv-rescale", "Rescale source", "anchor", 0.96);
    input.extraction.topics = [
      {
        label: "Heavily-supported topic",
        summary: "Lots of evidence.",
        confidence: 0.97,
        evidence: [
          { quote: "evidence one", turnRole: "user", confidence: 0.97 },
          { quote: "evidence two", turnRole: "user", confidence: 0.97 },
          { quote: "evidence three", turnRole: "user", confidence: 0.97 },
          { quote: "evidence four", turnRole: "user", confidence: 0.97 }
        ]
      },
      {
        label: "Modest topic",
        summary: "Two quotes.",
        confidence: 0.97,
        evidence: [
          { quote: "modest one", turnRole: "user", confidence: 0.97 },
          { quote: "modest two", turnRole: "user", confidence: 0.97 }
        ]
      },
      {
        label: "Thin topic",
        summary: "One quote.",
        confidence: 0.97,
        evidence: [{ quote: "thin one", turnRole: "user", confidence: 0.97 }]
      }
    ];

    const distinctProvider: AIProvider = {
      ...provider,
      async embedText(text: string): Promise<number[]> {
        const lower = text.toLowerCase();
        if (lower.includes("heavily")) return [1, 0, 0, 0];
        if (lower.includes("modest")) return [0, 1, 0, 0];
        if (lower.includes("thin")) return [0, 0, 1, 0];
        return [0, 0, 0, 1];
      }
    };

    const graph = await buildContextGraph(
      [input],
      { ...DEFAULT_SETTINGS, minimumCanonicalSources: 1, synthesizeNodeSummaries: false },
      distinctProvider
    );

    const topics = graph.nodes
      .filter((node) => node.type === "topic")
      .sort((left, right) => right.evidence.length - left.evidence.length);

    expect(topics).toHaveLength(3);
    expect(topics[0].confidence).toBeCloseTo(0.99, 2);
    expect(topics[2].confidence).toBeCloseTo(0.55, 2);
    expect(topics[0].confidence - topics[2].confidence).toBeGreaterThanOrEqual(0.4);
  });

  it("anchors singleton-type buckets at 0.85 instead of 0.99 to avoid inflation", async () => {
    const graph = await buildContextGraph(
      [extractionInput("conv-singleton", "Singleton", "Obsidian", 0.98)],
      { ...DEFAULT_SETTINGS, minimumCanonicalSources: 1, synthesizeNodeSummaries: false },
      provider
    );

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].confidence).toBe(0.85);
  });

  it("routes single-source supported self-model inferences to the review queue", async () => {
    const input = extractionInput("conv-pattern-review", "UX references", "placeholder", 0.4);
    input.extraction.topics = [];
    input.extraction.patterns = [
      {
        label: "Reference-driven UX design",
        summary: "The user draws UX mechanics from proven consumer apps.",
        confidence: 0.78,
        stability: "recurring",
        inferenceLevel: "supported_inference",
        appliesTo: ["product design", "onboarding"],
        agentInstruction: "When designing UX, translate proven app mechanics into concrete flow decisions.",
        evidence: [
          {
            quote: "I like Duolingo's lesson-first onboarding better.",
            turnRole: "user",
            confidence: 0.78
          }
        ]
      }
    ];

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider);

    expect(graph.nodes.filter((node) => node.type === "pattern")).toHaveLength(0);
    expect(graph.reviewQueueItems).toHaveLength(1);
    expect(graph.reviewQueueItems[0].label).toBe("Reference-driven UX design");
    expect(graph.reviewQueueItems[0].path).toBe("Context Graph/Review Queue.md");
    expect(graph.reviewQueueItems[0].status).toBe("pending");
  });

  it("promotes approved review items and suppresses rejected review items", async () => {
    const approvedInput = extractionInput("conv-approved-review", "UX references", "placeholder", 0.4);
    approvedInput.extraction.topics = [];
    approvedInput.extraction.patterns = [
      graphItem(
        "Reference-driven UX design",
        "The user draws UX mechanics from proven consumer apps.",
        0.78
      )
    ];
    approvedInput.extraction.patterns[0].inferenceLevel = "supported_inference";
    approvedInput.extraction.patterns[0].stability = "recurring";

    const approvedGraph = await buildContextGraph(
      [approvedInput],
      DEFAULT_SETTINGS,
      provider,
      {
        nodeSeeds: [],
        reviewSeeds: [
          reviewSeed("approved", "pattern", "Reference-driven UX design")
        ]
      }
    );

    expect(approvedGraph.nodes.filter((node) => node.type === "pattern")).toHaveLength(1);
    expect(approvedGraph.stats.promotedReviewItems).toBe(1);

    const approvedSeedOnlyGraph = await buildContextGraph(
      [],
      DEFAULT_SETTINGS,
      provider,
      {
        nodeSeeds: [],
        reviewSeeds: [
          reviewSeed("approved", "pattern", "Reference-driven UX design")
        ]
      }
    );

    expect(approvedSeedOnlyGraph.nodes.filter((node) => node.type === "pattern")).toHaveLength(1);

    const rejectedGraph = await buildContextGraph(
      [approvedInput],
      DEFAULT_SETTINGS,
      provider,
      {
        nodeSeeds: [],
        reviewSeeds: [
          reviewSeed("rejected", "pattern", "Reference-driven UX design")
        ]
      }
    );

    expect(rejectedGraph.nodes.filter((node) => node.type === "pattern")).toHaveLength(0);
    expect(rejectedGraph.reviewQueueItems).toHaveLength(1);
    expect(rejectedGraph.reviewQueueItems[0].status).toBe("rejected");
    expect(rejectedGraph.stats.suppressedReviewItems).toBe(1);
  });

  it("migrates legacy style pattern candidates into pattern nodes", async () => {
    const input = extractionInput("conv-style-pattern", "Style request", "placeholder", 0.4);
    input.extraction.topics = [];
    input.extraction.stylePatterns = [
      {
        label: "Concise high-density writing",
        summary: "The user prefers concise but information-dense writing.",
        confidence: 0.96,
        stability: "stable",
        inferenceLevel: "explicit",
        appliesTo: ["writing", "planning"],
        agentInstruction: "Keep writing compact but dense.",
        evidence: [
          {
            quote: "make it concise but still detailed enough to use",
            turnRole: "user",
            confidence: 0.96
          }
        ]
      }
    ];

    const graph = await buildContextGraph([input], DEFAULT_SETTINGS, provider);
    const pattern = graph.nodes.find((node) => node.type === "pattern");

    expect(pattern?.label).toBe("Concise high-density writing");
    expect(graph.nodes.some((node) => node.type === "style_pattern")).toBe(false);
  });
});

function seed(
  type: CanonicalNodeSeed["type"],
  label: string,
  confidence: number,
  sourceIds: string[]
): CanonicalNodeSeed {
  return {
    type,
    id: `${type}_${label.toLowerCase().replace(/\s+/g, "-")}`,
    label,
    slug: label.toLowerCase().replace(/\s+/g, "-"),
    aliases: [],
    path: `Context Graph/${type === "project" ? "Projects" : "Topics"}/${label}.md`,
    summary: `${label} summary.`,
    confidence,
    evidence: sourceIds.map((sourceId) => ({
      sourceId,
      sourceTitle: sourceId,
      sourcePath: `Context Graph/Sources/ChatGPT/${sourceId}.md`,
      quote: `${label} evidence ${sourceId}`,
      confidence
    })),
    sourceIds
  };
}

function reviewSeed(
  status: ReviewQueueSeed["status"],
  type: ReviewQueueSeed["type"],
  label: string
): ReviewQueueSeed {
  return {
    type,
    id: `review_${type}_${label.toLowerCase().replace(/\s+/g, "-")}`,
    label,
    slug: label.toLowerCase().replace(/\s+/g, "-"),
    aliases: [],
    path: "Context Graph/Review Queue.md",
    summary: `${label} summary.`,
    confidence: 0.78,
    evidence: [
      {
        sourceId: "review-source",
        sourceTitle: "Review source",
        sourcePath: "Context Graph/Sources/ChatGPT/review-source.md",
        quote: `${label} evidence`,
        confidence: 0.78
      }
    ],
    sourceIds: ["review-source"],
    stability: "recurring",
    inferenceLevel: "supported_inference",
    appliesTo: ["product design"],
    agentInstruction: "Use this reviewed self-model signal.",
    status
  };
}

function projectInput(
  sourceId: string,
  title: string,
  projects: ExtractedContext["projects"]
): ConversationExtraction {
  const input = extractionInput(sourceId, title, "placeholder", 0.9);
  input.extraction.topics = [];
  input.extraction.projects = projects;
  return input;
}

function extractionInput(
  sourceId: string,
  title: string,
  topicLabel: string,
  confidence: number
): ConversationExtraction {
  const conversation: ParsedConversation = {
    source: "chatgpt",
    sourceId,
    title,
    turns: [
      {
        id: `${sourceId}-turn`,
        role: "user",
        text: `Let's use ${topicLabel} for agent memory.`
      }
    ],
    rawMessageCount: 1
  };

  return {
    conversation,
    extraction: {
      sourceId,
      conversationTitle: title,
      summary: `Discussion about ${topicLabel}.`,
      confidence,
      topics: [
        {
          label: topicLabel,
          summary: `${topicLabel} is relevant to the user's graph UI work.`,
          confidence,
      evidence: [
        {
          quote: `Let's use ${topicLabel} for agent memory.`,
              turnRole: "user",
              confidence
            }
          ]
        }
      ],
      entities: [],
      projects: [],
      patterns: [],
      principles: [],
      agentInstructions: [],
      preferences: [],
      decisions: [],
      tasks: [],
      artifacts: [],
      stylePatterns: [],
      extractedAt: "2026-05-06T00:00:00.000Z"
    }
  };
}

function graphItem(
  label: string,
  summary: string,
  confidence: number
): ExtractedContext["topics"][number] {
  return {
    label,
    summary,
    confidence,
    evidence: [
      {
        quote: `${label}: ${summary}`,
        turnRole: "user",
        confidence
      }
    ]
  };
}
