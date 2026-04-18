const path = require("path");

const {
  chunkReplyText,
  markdownToPlainText,
  utf8ByteLength,
} = require("../infra/weixin/message-utils");

function buildPlanSummaryText(text) {
  const normalized = markdownToPlainText(text);
  if (!normalized) {
    return "";
  }

  const preferredHeadings = [
    "summary",
    "key changes",
    "implementation changes",
    "test plan",
    "assumptions",
    "plan",
  ];
  const sections = extractMarkdownSections(normalized);
  const selected = [];
  let totalLength = 0;

  for (const heading of preferredHeadings) {
    const body = sections.get(heading);
    if (!body) {
      continue;
    }
    const excerpt = trimTextBlock(body, heading === "summary" ? 520 : 320);
    if (!excerpt) {
      continue;
    }
    selected.push(`${toDisplayHeading(heading)}:\n${excerpt}`);
    totalLength += excerpt.length;
    if (totalLength >= 1400) {
      break;
    }
  }

  if (selected.length) {
    return selected.join("\n\n");
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const fallback = [];
  totalLength = 0;
  for (const line of lines) {
    if (fallback.length >= 10 || totalLength >= 1400) {
      break;
    }
    fallback.push(line);
    totalLength += line.length;
  }
  return fallback.join("\n");
}

function formatPlanCompletionReply({ workspaceRoot, planFilePath, summaryText }) {
  const workspaceName = getWorkspaceLabel(workspaceRoot);
  const sections = [];
  if (summaryText) {
    sections.push({
      heading: "计划摘要",
      body: summaryText,
    });
  }
  sections.push({
    heading: "下一步",
    body: "确认后发送 /codex execute 开始执行。",
  });

  return buildStructuredReplyChunks({
    title: "【计划已生成】执行前摘要",
    metaLines: [
      `项目: ${workspaceName}`,
      workspaceRoot ? `路径: ${workspaceRoot}` : "",
      planFilePath ? `计划文件: ${planFilePath}` : "",
    ].filter(Boolean),
    sections,
  });
}

function formatTaskCompletionReply({
  workspaceRoot,
  replyText,
  autoSent,
  autoSendFailed,
}) {
  const workspaceName = getWorkspaceLabel(workspaceRoot);
  const replySegments = splitReplyIntoOrderedSegments(replyText);
  const hasStructuredArtifact = replySegments.some((segment) => segment.kind === "code");
  const sections = hasStructuredArtifact
    ? buildSequentialReplySections(replySegments)
    : [...buildTaskContentSections(markdownToPlainText(replyText))];

  if (Array.isArray(autoSent) && autoSent.length) {
    sections.push({
      heading: "附件已发送",
      body: autoSent
        .map((item) => {
          const fileName = item.fileName || path.basename(item.filePath || "") || "(unknown file)";
          const kind = item.kind ? ` [${item.kind}]` : "";
          return `- ${fileName}${kind}`;
        })
        .join("\n"),
    });
  }

  if (Array.isArray(autoSendFailed) && autoSendFailed.length) {
    sections.push({
      heading: "附件异常",
      body: autoSendFailed
        .map((item) => {
          const label = path.basename(item.filePath || "") || item.filePath || "(unknown file)";
          return `- ${label}: ${item.reason || "upload failed"}`;
        })
        .join("\n"),
    });
  }

  if (!sections.length) {
    sections.push({
      heading: "结果",
      body: "已完成。",
    });
  }

  return buildStructuredReplyChunks({
    title: "【已完成】任务结果",
    metaLines: [
      `项目: ${workspaceName}`,
      workspaceRoot ? `路径: ${workspaceRoot}` : "",
    ].filter(Boolean),
    sections,
  });
}

function shouldUsePromptDelivery(replyText) {
  const raw = String(replyText || "").trim();
  if (!raw) {
    return false;
  }

  const segments = splitReplyIntoOrderedSegments(raw);
  if (!segments.length) {
    return false;
  }

  const codeSegments = segments.filter((segment) => segment.kind === "code");
  const codeBytes = codeSegments.reduce((total, segment) => total + utf8ByteLength(segment.text || ""), 0);
  const totalBytes = utf8ByteLength(raw);
  if (!totalBytes) {
    return false;
  }

  const codeRatio = codeBytes / totalBytes;
  if (raw.startsWith("```") && codeSegments.length) {
    return true;
  }
  if (raw.includes("<proposed_plan>") || raw.includes("</proposed_plan>")) {
    return true;
  }
  return codeRatio >= 0.55 && totalBytes >= 1200;
}

function formatPromptDeliveryReply({
  workspaceRoot,
  replyText,
  autoSent,
  autoSendFailed,
}) {
  const workspaceName = getWorkspaceLabel(workspaceRoot);
  const sections = [];
  const replySegments = splitReplyIntoOrderedSegments(replyText);
  const promptSummary = buildPromptDeliverySummary(replySegments, replyText);

  if (promptSummary) {
    sections.push({
      heading: "导读",
      body: promptSummary,
      kind: "text",
    });
  }

  if (replySegments.length) {
    sections.push(...buildPromptDeliverySections(replySegments));
  } else if (normalizeText(replyText)) {
    sections.push({
      heading: "完整输出",
      body: markdownToPlainText(replyText),
      kind: "text",
    });
  }

  if (Array.isArray(autoSent) && autoSent.length) {
    sections.push({
      heading: "附件已发送",
      body: autoSent
        .map((item) => {
          const fileName = item.fileName || path.basename(item.filePath || "") || "(unknown file)";
          const kind = item.kind ? ` [${item.kind}]` : "";
          return `- ${fileName}${kind}`;
        })
        .join("\n"),
    });
  }

  if (Array.isArray(autoSendFailed) && autoSendFailed.length) {
    sections.push({
      heading: "附件异常",
      body: autoSendFailed
        .map((item) => {
          const label = path.basename(item.filePath || "") || item.filePath || "(unknown file)";
          return `- ${label}: ${item.reason || "upload failed"}`;
        })
        .join("\n"),
    });
  }

  if (!sections.length) {
    sections.push({
      heading: "完整输出",
      body: "已完成。",
      kind: "text",
    });
  }

  return buildStructuredReplyChunks({
    title: "【已完成】完整输出",
    metaLines: [
      `项目: ${workspaceName}`,
      workspaceRoot ? `路径: ${workspaceRoot}` : "",
    ].filter(Boolean),
    sections,
  });
}

function formatTaskFailureReply({ workspaceRoot, replyText, failureText }) {
  const workspaceName = getWorkspaceLabel(workspaceRoot);
  const sections = [];
  const plainText = markdownToPlainText(replyText);
  if (plainText) {
    sections.push({
      heading: "已返回内容",
      body: plainText,
    });
  }
  sections.push({
    heading: "失败信息",
    body: markdownToPlainText(failureText) || "执行失败",
  });

  return buildStructuredReplyChunks({
    title: "【执行失败】任务结果",
    metaLines: [
      `项目: ${workspaceName}`,
      workspaceRoot ? `路径: ${workspaceRoot}` : "",
    ].filter(Boolean),
    sections,
  });
}

function buildStructuredReplyChunks({ title, metaLines = [], sections = [], limit = 3000 }) {
  const headerReserve = 64;
  const bodyLimit = Math.max(800, limit - headerReserve);
  const blocks = [];

  if (metaLines.length) {
    blocks.push(metaLines.join("\n"));
  }

  for (const section of sections) {
    const heading = normalizeText(section?.heading);
    const body = normalizeText(section?.body);
    if (!heading || !body) {
      continue;
    }
    const sectionPrefix = `${heading}:`;
    const sectionLimit = Math.max(320, bodyLimit - utf8ByteLength(sectionPrefix) - utf8ByteLength("\n"));
    const pieces = splitSectionBody(body, sectionLimit, section?.kind || "text");
    for (const piece of pieces) {
      blocks.push(`${sectionPrefix}\n${piece}`);
    }
  }

  if (!blocks.length) {
    blocks.push("结果:\n已完成。");
  }

  const chunkBodies = [];
  let current = "";
  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }
    const candidate = `${current}\n\n${block}`;
    if (utf8ByteLength(candidate) <= bodyLimit) {
      current = candidate;
      continue;
    }
    chunkBodies.push(current);
    current = block;
  }
  if (current) {
    chunkBodies.push(current);
  }

  return chunkBodies.map((body, index) => {
    const chunkTitle = withSequence(title, index + 1, chunkBodies.length);
    return [chunkTitle, body].filter(Boolean).join("\n\n").trim();
  });
}

function buildTaskContentSections(plainText) {
  const normalized = normalizeText(plainText);
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!paragraphs.length) {
    return [];
  }

  if (normalized.length <= 500 && normalized.split("\n").length <= 8) {
    return [{ heading: "结果", body: normalized }];
  }

  const summary = trimTextBlock(paragraphs[0], 320);
  const remaining = paragraphs.slice(1).join("\n\n").trim();
  const sections = [];

  if (summary) {
    sections.push({ heading: "摘要", body: summary });
  }

  if (remaining) {
    sections.push({ heading: "详细内容", body: remaining });
  } else if (normalized !== summary) {
    sections.push({ heading: "详细内容", body: normalized });
  }

  return sections;
}

function buildSequentialReplySections(segments) {
  const sections = [];
  for (const segment of segments) {
    const body = normalizeText(segment?.text);
    if (!body) {
      continue;
    }
    sections.push({
      heading: segment.kind === "code" ? "详细内容" : (sections.length ? "详细内容" : "摘要"),
      body,
      kind: segment.kind,
    });
  }
  return sections;
}

function buildPromptDeliverySections(segments) {
  const sections = [];
  let textIndex = 0;
  let codeIndex = 0;

  for (const segment of segments) {
    const body = normalizeText(segment?.text);
    if (!body) {
      continue;
    }
    if (segment.kind === "code") {
      codeIndex += 1;
      sections.push({
        heading: `Prompt ${codeIndex}`,
        body,
        kind: "code",
      });
      continue;
    }

    textIndex += 1;
    sections.push({
      heading: codeIndex === 0 && textIndex === 1 ? "说明" : `补充说明 ${textIndex}`,
      body,
      kind: "text",
    });
  }

  return sections;
}

function buildPromptDeliverySummary(segments, replyText) {
  const raw = normalizeText(replyText);
  if (!raw) {
    return "";
  }

  const introText = segments
    .filter((segment) => segment.kind === "text")
    .map((segment) => normalizeText(segment.text))
    .find(Boolean) || "";
  const codeText = segments
    .filter((segment) => segment.kind === "code")
    .map((segment) => normalizeText(segment.text))
    .find(Boolean) || markdownToPlainText(raw);

  const goal = buildPromptGoalLine(introText, codeText);
  const output = buildPromptOutputLine(codeText);
  const notes = buildPromptNotesLine(codeText);

  return [goal, output, notes].filter(Boolean).join("\n");
}

function buildPromptGoalLine(introText, codeText) {
  const introLine = firstMeaningfulLine(introText);
  if (introLine) {
    return `目标：${trimTextBlock(introLine, 110)}`;
  }

  const ideaBlock = extractPromptSectionBody(codeText, "我的研究想法是");
  if (ideaBlock) {
    const firstLine = firstMeaningfulLine(ideaBlock);
    if (firstLine) {
      return `目标：${trimTextBlock(firstLine, 110)}`;
    }
  }

  const firstLine = firstMeaningfulLine(codeText);
  if (firstLine) {
    return `目标：${trimTextBlock(firstLine, 110)}`;
  }
  return "";
}

function buildPromptOutputLine(codeText) {
  const hints = [];

  if (containsAll(codeText, ["A. 高度相似文献", "B. 机制或变量相近的可借鉴文献", "C. 情境不同但理论可迁移的文献"])) {
    hints.push("按 A / B / C 三组组织");
  }
  if (codeText.includes("先给一个 1 段的总体结论") || codeText.includes("先给一个1段的总体结论")) {
    hints.push("先给总体结论");
  }
  if (codeText.includes("最后给 research gap 判断") || codeText.includes("最后给 research gap")) {
    hints.push("最后给 research gap 判断");
  }
  if (codeText.includes("对每篇文献请提供以下信息")) {
    hints.push("每篇文献附题目/作者/年份/出处/链接/相关性说明");
  }

  if (!hints.length) {
    const outputReqBlock = extractPromptSectionBody(codeText, "输出格式要求");
    const line = firstMeaningfulLine(outputReqBlock);
    if (line) {
      return `输出：${trimTextBlock(line, 120)}`;
    }
    return "";
  }

  return `输出：${trimTextBlock(hints.join("；"), 140)}`;
}

function buildPromptNotesLine(codeText) {
  const notes = [];

  if (codeText.includes("优先返回真实存在") || codeText.includes("优先返回真实存在、可核验")) {
    notes.push("优先真实可核验文献");
  }
  if (codeText.includes("尽量优先给近10年的文献") || codeText.includes("尽量优先给近 10 年的文献")) {
    notes.push("优先近 10 年文献");
  }
  if (codeText.includes("需进一步核验")) {
    notes.push("不确定项标注“需进一步核验”");
  }
  if (codeText.includes("不要只给关键词建议")) {
    notes.push("不要只给关键词建议");
  }

  if (!notes.length) {
    return "";
  }
  return `注意：${trimTextBlock(notes.join("；"), 120)}`;
}

function extractPromptSectionBody(text, marker) {
  const normalizedText = normalizeText(text);
  const normalizedMarker = normalizeText(marker);
  if (!normalizedText || !normalizedMarker) {
    return "";
  }

  const markerIndex = normalizedText.indexOf(normalizedMarker);
  if (markerIndex < 0) {
    return "";
  }

  const afterMarker = normalizedText.slice(markerIndex + normalizedMarker.length);
  const trimmedAfterMarker = afterMarker.replace(/^[:：\s]+/, "");
  const nextSectionMatch = trimmedAfterMarker.match(/\n\s*\n\s*(\d+\.\s+|[A-Z]\.\s+|[一二三四五六七八九十]+[、.])/);
  const body = nextSectionMatch
    ? trimmedAfterMarker.slice(0, nextSectionMatch.index)
    : trimmedAfterMarker;
  return normalizeText(body);
}

function firstMeaningfulLine(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);
  return lines[0] || "";
}

function containsAll(text, parts) {
  const normalized = String(text || "");
  return parts.every((part) => normalized.includes(part));
}

function splitReplyIntoOrderedSegments(replyText) {
  const raw = String(replyText || "").trim();
  if (!raw) {
    return [];
  }

  const segments = [];
  const fencedPattern = /```[^\n]*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match = null;

  while ((match = fencedPattern.exec(raw)) !== null) {
    const before = raw.slice(lastIndex, match.index).trim();
    if (before) {
      segments.push({ kind: "text", text: markdownToPlainText(before) });
    }
    const codeBody = normalizeText(match[1]);
    if (codeBody) {
      segments.push({ kind: "code", text: codeBody });
    }
    lastIndex = fencedPattern.lastIndex;
  }

  const tail = raw.slice(lastIndex).trim();
  if (tail) {
    segments.push({ kind: "text", text: markdownToPlainText(tail) });
  }

  return segments.filter((segment) => normalizeText(segment.text));
}

function splitSectionBody(body, limit, kind = "text") {
  const paragraphs = String(body || "")
    .split(kind === "code" ? /\n{2,}/ : /\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const pieces = [];
  let current = "";

  for (const paragraph of paragraphs.length ? paragraphs : [body]) {
    if (!paragraph) {
      continue;
    }

    if (!current) {
      if (utf8ByteLength(paragraph) <= limit) {
        current = paragraph;
      } else {
        pieces.push(...splitLongBlock(paragraph, limit, kind));
      }
      continue;
    }

    const candidate = `${current}\n\n${paragraph}`;
    if (utf8ByteLength(candidate) <= limit) {
      current = candidate;
      continue;
    }

    pieces.push(current);
    if (utf8ByteLength(paragraph) <= limit) {
      current = paragraph;
    } else {
      pieces.push(...splitLongBlock(paragraph, limit, kind));
      current = "";
    }
  }

  if (current) {
    pieces.push(current);
  }

  return pieces.filter(Boolean);
}

function splitLongBlock(text, limit, kind) {
  if (kind !== "code") {
    return chunkReplyText(text, limit);
  }

  const lines = String(text || "").split("\n");
  const pieces = [];
  let current = "";
  for (const line of lines) {
    const normalizedLine = String(line || "");
    if (!current) {
      if (utf8ByteLength(normalizedLine) <= limit) {
        current = normalizedLine;
      } else {
        pieces.push(...chunkReplyText(normalizedLine, limit));
      }
      continue;
    }

    const candidate = `${current}\n${normalizedLine}`;
    if (utf8ByteLength(candidate) <= limit) {
      current = candidate;
      continue;
    }

    pieces.push(current);
    if (utf8ByteLength(normalizedLine) <= limit) {
      current = normalizedLine;
    } else {
      pieces.push(...chunkReplyText(normalizedLine, limit));
      current = "";
    }
  }

  if (current) {
    pieces.push(current);
  }
  return pieces.filter(Boolean);
}

function extractMarkdownSections(text) {
  const sections = new Map();
  const lines = String(text || "").split("\n");
  let currentHeading = "";
  let currentLines = [];

  const flush = () => {
    if (!currentHeading || !currentLines.length) {
      currentLines = [];
      return;
    }
    sections.set(currentHeading, currentLines.join("\n").trim());
    currentLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      currentHeading = normalizeHeadingKey(headingMatch[1]);
      continue;
    }
    if (!currentHeading) {
      continue;
    }
    currentLines.push(line);
  }

  flush();
  return sections;
}

function trimTextBlock(text, maxLength) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }
  if (utf8ByteLength(normalized) <= maxLength) {
    return normalized;
  }
  const chunks = chunkReplyText(normalized, maxLength);
  return chunks[0] || normalized.trim();
}

function getWorkspaceLabel(workspaceRoot) {
  const normalized = normalizeText(workspaceRoot);
  if (!normalized) {
    return "(未绑定项目)";
  }
  return path.basename(normalized) || normalized;
}

function normalizeHeadingKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/\s+/g, " ");
}

function toDisplayHeading(heading) {
  const table = {
    summary: "Summary",
    "key changes": "Key Changes",
    "implementation changes": "Implementation Changes",
    "test plan": "Test Plan",
    assumptions: "Assumptions",
    plan: "Plan",
  };
  return table[heading] || heading;
}

function withSequence(title, index, total) {
  const normalized = normalizeText(title);
  if (!normalized || total <= 1) {
    return normalized;
  }

  const match = normalized.match(/^【([^】]+)】\s*(.*)$/);
  if (!match) {
    return `${normalized} ${index}/${total}`;
  }

  const suffix = normalizeText(match[2]);
  return `【${match[1]} ${index}/${total}】${suffix ? ` ${suffix}` : ""}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  buildPlanSummaryText,
  formatPlanCompletionReply,
  formatPromptDeliveryReply,
  formatTaskCompletionReply,
  formatTaskFailureReply,
  shouldUsePromptDelivery,
};
