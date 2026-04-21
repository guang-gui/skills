#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PRIMITIVE_EXAMPLES = {
  String: "string",
  CharSequence: "string",
  char: "c",
  Character: "c",
  boolean: false,
  Boolean: false,
  byte: 0,
  Byte: 0,
  short: 0,
  Short: 0,
  int: 0,
  Integer: 0,
  long: 0,
  Long: 0,
  float: 0,
  Float: 0,
  double: 0,
  Double: 0,
  BigDecimal: 0,
  BigInteger: 0,
  Date: "2026-01-01 00:00:00",
  LocalDate: "2026-01-01",
  LocalDateTime: "2026-01-01T00:00:00",
  LocalTime: "00:00:00",
  Timestamp: "2026-01-01 00:00:00",
  MultipartFile: "<binary>",
  Object: { note: "untyped object" }
};

const COLLECTION_TYPES = new Set(["List", "Set", "Collection", "ArrayList", "LinkedList", "HashSet"]);
const MAP_TYPES = new Set(["Map", "HashMap", "LinkedHashMap", "TreeMap"]);
const VALIDATION_REQUIRED_MARKERS = new Set(["NotNull", "NotBlank", "NotEmpty", "NonNull"]);
const WRAPPER_TYPES = new Set(["Result", "PageResult", "PagingResult", "PPageResult"]);
const ROUTE_ANNOTATIONS = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH"
};

function fail(message) {
  throw new Error(message);
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed[trimmed.length - 1] && (trimmed[0] === '"' || trimmed[0] === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function cleanPath(value) {
  if (!value) return "/";
  const merged = (`/${value}`.replace(/^\/+/, "/")).replace(/\/+/g, "/");
  return merged === "" ? "/" : merged.replace(/\/$/, "") || "/";
}

function splitTopLevel(text, delimiter = ",") {
  const items = [];
  let current = "";
  let depthAngle = 0;
  let depthRound = 0;
  let depthSquare = 0;
  let depthCurly = 0;
  let inString = null;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      current += char;
      continue;
    }
    if (char === "<") depthAngle += 1;
    else if (char === ">") depthAngle = Math.max(0, depthAngle - 1);
    else if (char === "(") depthRound += 1;
    else if (char === ")") depthRound = Math.max(0, depthRound - 1);
    else if (char === "[") depthSquare += 1;
    else if (char === "]") depthSquare = Math.max(0, depthSquare - 1);
    else if (char === "{") depthCurly += 1;
    else if (char === "}") depthCurly = Math.max(0, depthCurly - 1);

    if (char === delimiter && depthAngle === 0 && depthRound === 0 && depthSquare === 0 && depthCurly === 0) {
      if (current.trim()) items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function parseType(typeText) {
  let raw = typeText.trim().replace(/\? extends /g, "").replace(/\? super /g, "");
  const arrayDims = (raw.match(/\[\]/g) || []).length;
  raw = raw.replace(/\[\]/g, "").trim();
  if (!raw.includes("<")) {
    return { raw: typeText.trim(), base: raw, args: [], arrayDims };
  }
  const base = raw.slice(0, raw.indexOf("<")).trim();
  const inner = raw.slice(raw.indexOf("<") + 1, raw.lastIndexOf(">"));
  return {
    raw: typeText.trim(),
    base,
    args: splitTopLevel(inner).map(parseType),
    arrayDims
  };
}

function simpleName(typeRef) {
  return typeRef.base.split(".").pop();
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function parsePackageAndImports(source) {
  const packageMatch = source.match(/^\s*package\s+([\w.]+)\s*;/m);
  const packageName = packageMatch ? packageMatch[1] : "";
  const imports = {};
  for (const match of source.matchAll(/^\s*import\s+([\w.]+)\s*;/gm)) {
    const fqcn = match[1];
    imports[fqcn.split(".").pop()] = fqcn;
  }
  return { packageName, imports };
}

function findMatchingParen(text, start) {
  let depth = 0;
  let inString = null;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseAnnotationEntries(block) {
  const entries = [];
  let index = 0;
  while (index < block.length) {
    if (block[index] !== "@") {
      index += 1;
      continue;
    }
    const sliced = block.slice(index);
    const nameMatch = sliced.match(/^@(\w+)/);
    if (!nameMatch) {
      index += 1;
      continue;
    }
    const name = nameMatch[1];
    let cursor = index + nameMatch[0].length;
    let args = "";
    while (cursor < block.length && /\s/.test(block[cursor])) cursor += 1;
    if (block[cursor] === "(") {
      const end = findMatchingParen(block, cursor);
      if (end === -1) break;
      args = block.slice(cursor + 1, end);
      cursor = end + 1;
    }
    entries.push({ name, args });
    index = cursor;
  }
  return entries;
}

function parseAnnotationArgMap(args) {
  const trimmed = args.trim();
  if (!trimmed) return {};
  if (!trimmed.includes("=")) return { value: trimmed };
  const result = {};
  for (const part of splitTopLevel(trimmed)) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    result[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return result;
}

function firstAnnotationValue(argMap, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(argMap, key)) {
      const value = argMap[key].trim();
      if (value.startsWith("{") && value.endsWith("}")) {
        const parts = splitTopLevel(value.slice(1, -1));
        return parts.length ? stripQuotes(parts[0]) : "";
      }
      return stripQuotes(value);
    }
  }
  return "";
}

function boolAnnotationValue(argMap, key, defaultValue = false) {
  if (!Object.prototype.hasOwnProperty.call(argMap, key)) return defaultValue;
  return String(argMap[key]).trim().toLowerCase() === "true";
}

function parseApiImplicitParams(block) {
  const params = [];
      const regex = /@ApiImplicitParam\s*\(/g;
  let match;
  while ((match = regex.exec(block)) !== null) {
    const open = block.indexOf("(", match.index);
    const end = findMatchingParen(block, open);
    if (open === -1 || end === -1) break;
    const argMap = parseAnnotationArgMap(block.slice(open + 1, end));
    const paramName = firstAnnotationValue(argMap, "name");
    if (paramName) {
      const typeName = firstAnnotationValue(argMap, "dataType", "dataTypeClass") || "String";
      const source = firstAnnotationValue(argMap, "paramType") || "query";
      params.push({
        name: paramName,
        typeRef: parseType(typeName),
        source,
        required: boolAnnotationValue(argMap, "required"),
        description: firstAnnotationValue(argMap, "value")
      });
    }
    regex.lastIndex = end + 1;
  }
  return params;
}

function extractCommentSummary(comment) {
  if (!comment) return "";
  const lines = [];
  for (const rawLine of comment.split(/\r?\n/)) {
    let line = rawLine.trim();
    line = line.replace(/^\/\*\*?/, "").replace(/\*\/$/, "").replace(/^\*/, "").trim();
    if (line && !line.startsWith("@")) lines.push(line);
  }
  return lines.join(" ").trim();
}

function parseClassHeader(source, filePath) {
  const { packageName, imports } = parsePackageAndImports(source);
  const classMatch = source.match(/(?<prefix>(?:\s*\/\*\*.*?\*\/\s*|\s*@.*?\n)*)\s*public\s+(?:abstract\s+)?class\s+(?<name>\w+)/s);
  if (!classMatch || !classMatch.groups) fail(`Could not find public class in ${filePath}`);
  const prefix = classMatch.groups.prefix || "";
  const className = classMatch.groups.name;
  let categoryName = className;
  let basePath = "/";
  for (const entry of parseAnnotationEntries(prefix)) {
    const argMap = parseAnnotationArgMap(entry.args);
    if (entry.name === "Api") categoryName = firstAnnotationValue(argMap, "tags", "value") || categoryName;
    if (entry.name === "RequestMapping") basePath = cleanPath(firstAnnotationValue(argMap, "value", "path"));
  }
  return { packageName, imports, className, categoryName, basePath };
}

function locateClassBody(source, className) {
  const regex = new RegExp(`\\bclass\\s+${className}\\b`);
  const match = regex.exec(source);
  if (!match || match.index == null) fail(`Could not locate body for class ${className}`);
  const braceStart = source.indexOf("{", match.index + match[0].length);
  if (braceStart === -1) fail(`Could not find opening brace for class ${className}`);
  let depth = 0;
  for (let idx = braceStart; idx < source.length; idx += 1) {
    if (source[idx] === "{") depth += 1;
    else if (source[idx] === "}") {
      depth -= 1;
      if (depth === 0) return { start: braceStart, end: idx };
    }
  }
  fail(`Could not find closing brace for class ${className}`);
}

function extractTopLevelMethods(body) {
  const results = [];
  let depth = 1;
  let pendingAnnotations = [];
  let pendingComment = "";
  let currentComment = [];
  let collectingSignature = false;
  let signatureLines = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    const stripped = line.trim();
    if (stripped.startsWith("/**") && !collectingSignature && depth === 1) {
      currentComment = [line];
      if (stripped.includes("*/")) {
        pendingComment = currentComment.join("\n");
        currentComment = [];
      }
      continue;
    }
    if (currentComment.length) {
      currentComment.push(line);
      if (stripped.includes("*/")) {
        pendingComment = currentComment.join("\n");
        currentComment = [];
      }
      continue;
    }
    if (depth === 1 && !collectingSignature && stripped.startsWith("@")) {
      pendingAnnotations.push(stripped);
    } else if (depth === 1 && pendingAnnotations.length && !collectingSignature) {
      if (!stripped) {
        // skip
      } else if (/^(public|protected|private)\b/.test(stripped) && stripped.includes("(")) {
        signatureLines = [line];
        collectingSignature = true;
      } else if (stripped.endsWith(";")) {
        pendingAnnotations = [];
        pendingComment = "";
      } else {
        pendingAnnotations[pendingAnnotations.length - 1] += ` ${stripped}`;
      }
    } else if (collectingSignature) {
      signatureLines.push(line);
    }

    if (collectingSignature && stripped.includes("{")) {
      results.push({
        annotationBlock: pendingAnnotations.join("\n"),
        commentBlock: pendingComment,
        signature: signatureLines.map((part) => part.trim()).join(" ")
      });
      pendingAnnotations = [];
      pendingComment = "";
      collectingSignature = false;
      signatureLines = [];
    }

    if (!collectingSignature) {
      depth += (line.match(/\{/g) || []).length;
      depth -= (line.match(/\}/g) || []).length;
      if (depth < 1) break;
    }
  }
  return results;
}

function parseRouteAnnotation(annotationBlock) {
  const entries = parseAnnotationEntries(annotationBlock);
  for (const entry of entries) {
    if (ROUTE_ANNOTATIONS[entry.name]) {
      const route = firstAnnotationValue(parseAnnotationArgMap(entry.args), "value", "path");
      return { httpMethod: ROUTE_ANNOTATIONS[entry.name], methodPath: cleanPath(route) };
    }
    if (entry.name === "RequestMapping") {
      const argMap = parseAnnotationArgMap(entry.args);
      const route = cleanPath(firstAnnotationValue(argMap, "value", "path"));
      const methodValue = argMap.method || "";
      const methodMatch = methodValue.match(/RequestMethod\.(\w+)/);
      return { httpMethod: methodMatch ? methodMatch[1] : "GET", methodPath: route };
    }
  }
  fail("No route annotation found");
}

function parseMethodSignature(signature) {
  const normalized = signature.replace(/\s+/g, " ").trim();
  const openParen = normalized.indexOf("(");
  const openBrace = normalized.lastIndexOf("{");
  if (openParen === -1 || openBrace === -1 || openParen > openBrace) fail(`Could not parse method signature: ${signature}`);
  let depth = 0;
  let closeParen = -1;
  for (let i = openParen; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  if (closeParen === -1) fail(`Could not parse method signature: ${signature}`);
  const beforeParams = normalized.slice(0, openParen).trim();
  const beforeParts = beforeParams.split(/\s+/);
  const methodName = beforeParts.pop();
  const returnTypeText = beforeParts.filter((item) => !["public", "protected", "private", "static", "final"].includes(item)).join(" ").trim();
  const paramsText = normalized.slice(openParen + 1, closeParen).trim();
  if (!methodName || !returnTypeText) fail(`Could not parse method signature: ${signature}`);
  return { returnTypeText, methodName, paramsText };
}
function parseParamAnnotations(paramText) {
  const annotations = parseAnnotationEntries(paramText);
  const cleaned = paramText.replace(/@\w+(?:\((?:[^()]|\([^()]*\))*\))?\s*/g, "").replace(/\bfinal\s+/g, "").trim();
  return { annotations, cleaned };
}

function isSimpleType(typeRef) {
  return Object.prototype.hasOwnProperty.call(PRIMITIVE_EXAMPLES, simpleName(typeRef));
}

function inferParamSource(httpMethod, typeRef, annotations) {
  let source = "";
  let required = false;
  let description = "";
  for (const entry of annotations) {
    const argMap = parseAnnotationArgMap(entry.args);
    if (entry.name === "RequestBody") {
      source = "body";
      required = boolAnnotationValue(argMap, "required", true);
    } else if (entry.name === "PathVariable") {
      source = "path";
      required = true;
      description = firstAnnotationValue(argMap, "value", "name");
    } else if (entry.name === "RequestParam") {
      source = "query";
      required = boolAnnotationValue(argMap, "required", false);
      description = firstAnnotationValue(argMap, "value", "name");
    } else if (entry.name === "ApiParam") {
      description = firstAnnotationValue(argMap, "value");
    }
  }
  if (!source) {
    if (simpleName(typeRef) === "MultipartFile") source = "form";
    else if (isSimpleType(typeRef) || MAP_TYPES.has(simpleName(typeRef))) source = httpMethod === "GET" ? "query" : "form";
    else source = httpMethod !== "GET" ? "form" : "query";
  }
  return { source, required, description };
}

function parseMethodParams(httpMethod, paramsText) {
  if (!paramsText.trim()) return [];
  const params = [];
  for (const chunk of splitTopLevel(paramsText)) {
    const { annotations, cleaned } = parseParamAnnotations(chunk);
    if (!cleaned) continue;
    if (annotations.some((item) => item.name === "LoginUser")) continue;
    const lastSpace = cleaned.lastIndexOf(" ");
    if (lastSpace === -1) continue;
    const typeName = cleaned.slice(0, lastSpace).trim();
    const name = cleaned.slice(lastSpace + 1).trim();
    const typeRef = parseType(typeName);
    const ignoredTypes = new Set(["HttpServletRequest", "HttpServletResponse", "BindingResult", "Model", "ModelMap"]);
    if (ignoredTypes.has(simpleName(typeRef))) continue;
    const inferred = inferParamSource(httpMethod, typeRef, annotations);
    params.push({ name, typeRef, ...inferred });
  }
  return params;
}

function parseController(filePath) {
  const source = readText(filePath);
  const header = parseClassHeader(source, filePath);
  const bodyRange = locateClassBody(source, header.className);
  const body = source.slice(bodyRange.start + 1, bodyRange.end);
  const methods = [];
  for (const candidate of extractTopLevelMethods(body)) {
    if (!Object.keys(ROUTE_ANNOTATIONS).some((name) => candidate.annotationBlock.includes(name)) && !candidate.annotationBlock.includes("@RequestMapping")) {
      continue;
    }
    const route = parseRouteAnnotation(candidate.annotationBlock);
    const signature = parseMethodSignature(candidate.signature);
    const params = parseMethodParams(route.httpMethod, signature.paramsText);
    const implicitParams = parseApiImplicitParams(candidate.annotationBlock);
    const queryParams = params.filter((item) => item.source === "query");
    const pathParams = params.filter((item) => item.source === "path");
    const formParams = params.filter((item) => item.source === "form");
    const requestBody = params.find((item) => item.source === "body") || null;
    for (const implicit of implicitParams) {
      if (implicit.source === "path") pathParams.push(implicit);
      else queryParams.push(implicit);
    }
    let title = signature.methodName;
    for (const entry of parseAnnotationEntries(candidate.annotationBlock)) {
      if (entry.name === "ApiOperation") {
        title = firstAnnotationValue(parseAnnotationArgMap(entry.args), "value", "notes") || title;
      }
    }
    methods.push({
      name: signature.methodName,
      httpMethod: route.httpMethod,
      fullPath: cleanPath(`${header.basePath}/${route.methodPath.replace(/^\//, "")}`),
      title,
      description: extractCommentSummary(candidate.commentBlock),
      returnType: parseType(signature.returnTypeText),
      pathParams,
      queryParams,
      formParams,
      requestBody,
      sourceFile: filePath
    });
  }
  return {
    path: filePath,
    packageName: header.packageName,
    className: header.className,
    imports: header.imports,
    categoryName: header.categoryName || header.className,
    basePath: header.basePath,
    methods
  };
}

function walkJavaFiles(workspace) {
  const stack = [workspace];
  const files = [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".java")) files.push(fullPath);
    }
  }
  return files;
}

function buildJavaIndex(workspace) {
  const simpleIndex = new Map();
  const fqcnIndex = new Map();
  for (const filePath of walkJavaFiles(workspace)) {
    const simple = path.basename(filePath, ".java");
    if (!simpleIndex.has(simple)) simpleIndex.set(simple, []);
    simpleIndex.get(simple).push(filePath);
    const source = readText(filePath);
    const parsed = parsePackageAndImports(source);
    if (parsed.packageName) fqcnIndex.set(`${parsed.packageName}.${simple}`, filePath);
  }
  return { simpleIndex, fqcnIndex };
}

function resolveController(controller, workspace, simpleIndex, fqcnIndex) {
  if (fs.existsSync(controller)) return path.resolve(controller);
  const workspaceCandidate = path.resolve(workspace, controller);
  if (fs.existsSync(workspaceCandidate)) return workspaceCandidate;
  if (fqcnIndex.has(controller)) return fqcnIndex.get(controller);
  const simple = controller.split(".").pop();
  const matches = simpleIndex.get(simple) || [];
  if (!matches.length) fail(`Controller not found: ${controller}`);
  if (matches.length > 1) fail(`Controller is ambiguous: ${controller}\n${matches.join("\n")}`);
  return matches[0];
}

function resolveTypePath(typeRef, owner, simpleIndex, fqcnIndex) {
  const simple = simpleName(typeRef);
  if (PRIMITIVE_EXAMPLES[simple] !== undefined || WRAPPER_TYPES.has(simple) || COLLECTION_TYPES.has(simple) || MAP_TYPES.has(simple)) {
    return null;
  }
  if (owner.imports[simple] && fqcnIndex.has(owner.imports[simple])) return fqcnIndex.get(owner.imports[simple]);
  const samePackage = owner.packageName ? `${owner.packageName}.${simple}` : simple;
  if (fqcnIndex.has(samePackage)) return fqcnIndex.get(samePackage);
  const matches = simpleIndex.get(simple) || [];
  return matches.length === 1 ? matches[0] : null;
}

function parseJavaFields(filePath) {
  const source = readText(filePath);
  const parsed = parsePackageAndImports(source);
  const classMatch = source.match(/\bclass\s+(?<name>\w+)/);
  if (!classMatch || !classMatch.groups) fail(`No class found in ${filePath}`);
  const className = classMatch.groups.name;
  const bodyRange = locateClassBody(source, className);
  const body = source.slice(bodyRange.start + 1, bodyRange.end);
  let depth = 1;
  let pendingAnnotations = [];
  let pendingComment = "";
  let currentComment = [];
  const fields = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    const stripped = line.trim();
    if (stripped.startsWith("/**") && depth === 1) {
      currentComment = [line];
      if (stripped.includes("*/")) {
        pendingComment = currentComment.join("\n");
        currentComment = [];
      }
      continue;
    }
    if (currentComment.length) {
      currentComment.push(line);
      if (stripped.includes("*/")) {
        pendingComment = currentComment.join("\n");
        currentComment = [];
      }
      continue;
    }
    if (depth === 1 && stripped.startsWith("@")) {
      pendingAnnotations.push(stripped);
    } else if (depth === 1 && stripped.endsWith(";") && !stripped.includes("(") && !stripped.includes(")")) {
      const declaration = stripped.replace(/;$/, "");
      if (!/\b(static|serialVersionUID)\b/.test(declaration)) {
        const declarationWithoutInit = declaration.split("=")[0].trim();
        const lastSpace = declarationWithoutInit.lastIndexOf(" ");
        if (lastSpace !== -1) {
          const typeName = declarationWithoutInit.slice(0, lastSpace).replace(/\b(private|protected|public|final|transient|volatile)\b/g, "").trim();
          const fieldName = declarationWithoutInit.slice(lastSpace + 1).trim();
          let description = extractCommentSummary(pendingComment);
          let required = false;
          for (const entry of parseAnnotationEntries(pendingAnnotations.join("\n"))) {
            const argMap = parseAnnotationArgMap(entry.args);
            if (entry.name === "ApiModelProperty") {
              description = firstAnnotationValue(argMap, "value") || description;
              required = required || boolAnnotationValue(argMap, "required");
            }
            if (VALIDATION_REQUIRED_MARKERS.has(entry.name)) required = true;
          }
          fields.push({ name: fieldName, typeRef: parseType(typeName), required, description });
        }
      }
      pendingAnnotations = [];
      pendingComment = "";
    }
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
  }
  return { packageName: parsed.packageName, imports: parsed.imports, className, fields };
}

function buildExampleForType(typeRef, owner, simpleIndex, fqcnIndex, seen = new Set()) {
  const simple = simpleName(typeRef);
  if (typeRef.arrayDims > 0) return [buildExampleForType({ raw: typeRef.base, base: typeRef.base, args: typeRef.args, arrayDims: 0 }, owner, simpleIndex, fqcnIndex, seen)];
  if (PRIMITIVE_EXAMPLES[simple] !== undefined) return PRIMITIVE_EXAMPLES[simple];
  if (COLLECTION_TYPES.has(simple)) {
    const inner = typeRef.args[0] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    return [buildExampleForType(inner, owner, simpleIndex, fqcnIndex, seen)];
  }
  if (MAP_TYPES.has(simple)) {
    const valueType = typeRef.args[1] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    return { key: buildExampleForType(valueType, owner, simpleIndex, fqcnIndex, seen) };
  }
  if (simple === "Result") {
    const inner = typeRef.args[0] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    return { datas: buildExampleForType(inner, owner, simpleIndex, fqcnIndex, seen), resp_code: "0", resp_msg: "success" };
  }
  if (simple === "PageResult") {
    const inner = typeRef.args[0] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    return { count: 0, code: 0, data: [buildExampleForType(inner, owner, simpleIndex, fqcnIndex, seen)] };
  }
  if (simple === "PPageResult") {
    const inner = typeRef.args[0] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    return { count: 0, list: [buildExampleForType(inner, owner, simpleIndex, fqcnIndex, seen)], pageSize: 0, pageNum: 0, next: false };
  }
  if (simple === "PagingResult") {
    const inner = typeRef.args[0] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    return {
      datas: { count: 0, list: [buildExampleForType(inner, owner, simpleIndex, fqcnIndex, seen)], pageSize: 0, pageNum: 0, next: false },
      resp_code: "0",
      resp_msg: "success"
    };
  }
  const resolvedPath = resolveTypePath(typeRef, owner, simpleIndex, fqcnIndex);
  if (!resolvedPath) return { note: `unresolved type: ${typeRef.raw}` };
  if (seen.has(resolvedPath)) return { note: `cyclic reference: ${path.basename(resolvedPath, ".java")}` };
  seen.add(resolvedPath);
  const parsed = parseJavaFields(resolvedPath);
  const nestedOwner = { path: resolvedPath, packageName: parsed.packageName, className: parsed.className, imports: parsed.imports, categoryName: parsed.className, basePath: "/", methods: [] };
  const output = {};
  for (const field of parsed.fields) {
    output[field.name] = buildExampleForType(field.typeRef, nestedOwner, simpleIndex, fqcnIndex, seen);
  }
  seen.delete(resolvedPath);
  return Object.keys(output).length ? output : { note: `empty type: ${parsed.className}` };
}

function buildPrimitiveSchema(typeRef, description = "") {
  const simple = simpleName(typeRef);
  let schema;
  if (simple === "boolean" || simple === "Boolean") schema = { type: "boolean" };
  else if (["byte", "Byte", "short", "Short", "int", "Integer", "long", "Long", "BigInteger"].includes(simple)) schema = { type: "integer" };
  else if (["float", "Float", "double", "Double", "BigDecimal"].includes(simple)) schema = { type: "number" };
  else schema = { type: "string" };
  if (description) schema.description = description;
  return schema;
}

function buildSchemaForType(typeRef, owner, simpleIndex, fqcnIndex, seen = new Set(), description = "") {
  const simple = simpleName(typeRef);
  if (typeRef.arrayDims > 0) {
    const base = { raw: typeRef.base, base: typeRef.base, args: typeRef.args, arrayDims: 0 };
    const schema = { type: "array", items: buildSchemaForType(base, owner, simpleIndex, fqcnIndex, seen) };
    if (description) schema.description = description;
    return schema;
  }
  if (PRIMITIVE_EXAMPLES[simple] !== undefined) {
    return buildPrimitiveSchema(typeRef, description);
  }
  if (COLLECTION_TYPES.has(simple)) {
    const inner = typeRef.args[0] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    const schema = { type: "array", items: buildSchemaForType(inner, owner, simpleIndex, fqcnIndex, seen) };
    if (description) schema.description = description;
    return schema;
  }
  if (MAP_TYPES.has(simple)) {
    const valueType = typeRef.args[1] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    const schema = { type: "object", additionalProperties: buildSchemaForType(valueType, owner, simpleIndex, fqcnIndex, seen) };
    if (description) schema.description = description;
    return schema;
  }
  if (simple === "Result") {
    const inner = typeRef.args[0] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    const schema = {
      type: "object",
      properties: {
        datas: buildSchemaForType(inner, owner, simpleIndex, fqcnIndex, seen, "业务数据"),
        resp_code: buildPrimitiveSchema({ raw: "String", base: "String", args: [], arrayDims: 0 }, "响应码"),
        resp_msg: buildPrimitiveSchema({ raw: "String", base: "String", args: [], arrayDims: 0 }, "响应消息")
      }
    };
    if (description) schema.description = description;
    return schema;
  }
  if (simple === "PPageResult") {
    const inner = typeRef.args[0] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    const schema = {
      type: "object",
      properties: {
        count: buildPrimitiveSchema({ raw: "Long", base: "Long", args: [], arrayDims: 0 }, "总数"),
        list: {
          type: "array",
          items: buildSchemaForType(inner, owner, simpleIndex, fqcnIndex, seen),
          description: "当前页结果集"
        },
        pageSize: buildPrimitiveSchema({ raw: "long", base: "long", args: [], arrayDims: 0 }, "页面大小"),
        pageNum: buildPrimitiveSchema({ raw: "long", base: "long", args: [], arrayDims: 0 }, "页码"),
        next: buildPrimitiveSchema({ raw: "boolean", base: "boolean", args: [], arrayDims: 0 }, "是否下一页")
      }
    };
    if (description) schema.description = description;
    return schema;
  }
  if (simple === "PagingResult") {
    const inner = typeRef.args[0] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    const schema = {
      type: "object",
      properties: {
        datas: buildSchemaForType({ raw: `PPageResult<${inner.raw}>`, base: "PPageResult", args: [inner], arrayDims: 0 }, owner, simpleIndex, fqcnIndex, seen, "分页数据"),
        resp_code: buildPrimitiveSchema({ raw: "String", base: "String", args: [], arrayDims: 0 }, "响应码"),
        resp_msg: buildPrimitiveSchema({ raw: "String", base: "String", args: [], arrayDims: 0 }, "响应消息")
      }
    };
    if (description) schema.description = description;
    return schema;
  }
  if (simple === "PageResult") {
    const inner = typeRef.args[0] || { raw: "Object", base: "Object", args: [], arrayDims: 0 };
    const schema = {
      type: "object",
      properties: {
        count: buildPrimitiveSchema({ raw: "Long", base: "Long", args: [], arrayDims: 0 }, "总数"),
        code: buildPrimitiveSchema({ raw: "Integer", base: "Integer", args: [], arrayDims: 0 }, "响应码"),
        data: {
          type: "array",
          items: buildSchemaForType(inner, owner, simpleIndex, fqcnIndex, seen),
          description: "结果集"
        }
      }
    };
    if (description) schema.description = description;
    return schema;
  }
  const resolvedPath = resolveTypePath(typeRef, owner, simpleIndex, fqcnIndex);
  if (!resolvedPath) {
    const schema = { type: "object" };
    if (description) schema.description = description;
    return schema;
  }
  if (seen.has(resolvedPath)) {
    const schema = { type: "object" };
    if (description) schema.description = description;
    return schema;
  }
  seen.add(resolvedPath);
  const parsed = parseJavaFields(resolvedPath);
  const nestedOwner = {
    path: resolvedPath,
    packageName: parsed.packageName,
    className: parsed.className,
    imports: parsed.imports,
    categoryName: parsed.className,
    basePath: "/",
    methods: []
  };
  const properties = {};
  const required = [];
  for (const field of parsed.fields) {
    properties[field.name] = buildSchemaForType(field.typeRef, nestedOwner, simpleIndex, fqcnIndex, seen, field.description);
    if (field.required) required.push(field.name);
  }
  seen.delete(resolvedPath);
  const schema = { type: "object", properties };
  if (required.length) schema.required = required;
  if (description) schema.description = description;
  return schema;
}

function buildFormParams(params) {
  return params.map((param) => ({
    name: param.name,
    type: simpleName(param.typeRef) === "MultipartFile" ? "file" : "text",
    required: param.required ? "1" : "0",
    desc: param.description || `type: ${param.typeRef.raw}`
  }));
}

function buildKvParams(params) {
  return params.map((param) => ({
    name: param.name,
    required: param.required ? "1" : "0",
    example: "",
    desc: param.description || `type: ${param.typeRef.raw}`
  }));
}

function buildObjectQueryParams(typeRef, owner, simpleIndex, fqcnIndex) {
  const resolvedPath = resolveTypePath(typeRef, owner, simpleIndex, fqcnIndex);
  if (!resolvedPath) return [];
  const parsed = parseJavaFields(resolvedPath);
  return parsed.fields.map((field) => ({
    name: field.name,
    required: field.required ? "1" : "0",
    example: "",
    desc: field.description || `type: ${field.typeRef.raw}`
  }));
}

function isExportMethod(method) {
  const methodName = String(method.name || "").toLowerCase();
  const title = String(method.title || "");
  const pathValue = String(method.fullPath || "").toLowerCase();
  const returnSimple = simpleName(method.returnType);
  return returnSimple === "void" && (methodName.includes("export") || pathValue.includes("export") || title.includes("导出"));
}

function buildMethodPayload(controller, method, catid, projectId, token, simpleIndex, fqcnIndex) {
  let reqBodyType = "raw";
  let reqBodyOther = "";
  let reqBodyForm = [];
  let reqHeaders = [];
  let reqQuery = buildKvParams(method.queryParams);
  if (method.requestBody) {
    reqBodyType = "json";
    reqHeaders = [{ name: "Content-Type", value: "application/json", required: "1", example: "" }];
    const requestSchema = buildSchemaForType(method.requestBody.typeRef, controller, simpleIndex, fqcnIndex, new Set(), method.requestBody.description || "");
    reqBodyOther = JSON.stringify(requestSchema, null, 2);
  } else if (method.formParams.length) {
    reqBodyType = "form";
    reqBodyForm = buildFormParams(method.formParams);
  }
  const exportMethod = isExportMethod(method);
  if (exportMethod && method.httpMethod === "GET" && method.requestBody) {
    reqQuery = buildObjectQueryParams(method.requestBody.typeRef, controller, simpleIndex, fqcnIndex);
    reqBodyType = "raw";
    reqBodyOther = "";
    reqHeaders = [];
  }
  const responseSchema = exportMethod ? null : buildSchemaForType(method.returnType, controller, simpleIndex, fqcnIndex, new Set());
  const descParts = [method.description || "No method description in source."];
  if (exportMethod) descParts.push("返回内容：导出文件流，无 JSON 响应体。");
  return {
    token,
    project_id: projectId,
    catid,
    title: method.title,
    path: method.fullPath,
    method: method.httpMethod,
    status: "done",
    desc: descParts.join("\n"),
    req_params: buildKvParams(method.pathParams),
    req_query: reqQuery,
    req_headers: reqHeaders,
    req_body_type: reqBodyType,
    req_body_is_json_schema: true,
    req_body_form: reqBodyForm,
    req_body_other: reqBodyOther,
    res_body_type: exportMethod ? "raw" : "json",
    res_body_is_json_schema: exportMethod ? false : true,
    res_body: exportMethod ? "" : JSON.stringify(responseSchema, null, 2)
  };
}

function requestJson(method, requestUrl, payload) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(requestUrl);
    const lib = parsedUrl.protocol === "https:" ? https : http;
    const body = payload ? JSON.stringify(payload) : null;
    const req = lib.request({
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data || "{}");
          if (Number(parsed.errcode || 0) !== 0) reject(new Error(parsed.errmsg || "Unknown YApi error"));
          else resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

class YApiClient {
  constructor(baseUrl, token, projectId) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.projectId = projectId;
  }

  get(pathname, params) {
    const query = new URLSearchParams(params).toString();
    return requestJson("GET", `${this.baseUrl}${pathname}?${query}`);
  }

  post(pathname, payload) {
    return requestJson("POST", `${this.baseUrl}${pathname}`, payload);
  }

  async getCategories() {
    const data = await this.get("/api/interface/getCatMenu", { token: this.token, project_id: this.projectId });
    return data.data || [];
  }

  async ensureCategory(name) {
    const categories = await this.getCategories();
    const existing = categories.find((item) => item.name === name);
    if (existing) return Number(existing._id);
    const data = await this.post("/api/interface/add_cat", { token: this.token, project_id: this.projectId, name, desc: "" });
    return Number(data.data._id);
  }

  async listInterfaces(page = 1, limit = 1000) {
    const data = await this.get("/api/interface/list", { token: this.token, project_id: this.projectId, page, limit });
    return (data.data && data.data.list) || [];
  }

  async getInterface(id) {
    const data = await this.get("/api/interface/get", { token: this.token, id });
    return data.data || {};
  }

  async saveInterface(payload) {
    const data = await this.post("/api/interface/save", payload);
    return data.data || {};
  }
}

function loadConfig(configPath) {
  if (!configPath) return {};
  if (!fs.existsSync(configPath)) fail(`Config file not found: ${configPath}`);
  return JSON.parse(readText(configPath));
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--workspace") args.workspace = argv[++i];
    else if (token === "--controller") args.controller = argv[++i];
    else if (token === "--config") args.config = argv[++i];
    else fail(`Unknown argument: ${token}`);
  }
  if (!args.workspace) fail("--workspace is required");
  if (!args.controller) fail("--controller is required");
  return args;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace);
  if (!fs.existsSync(workspace)) fail(`Workspace not found: ${workspace}`);
  const { simpleIndex, fqcnIndex } = buildJavaIndex(workspace);
  const controllerPath = resolveController(args.controller, workspace, simpleIndex, fqcnIndex);
  const controller = parseController(controllerPath);
  if (!controller.methods.length) fail(`No request mapping methods found in ${controllerPath}`);

  if (args.dryRun) {
    const methods = controller.methods.map((method) => ({
      methodName: method.name,
      httpMethod: method.httpMethod,
      path: method.fullPath,
      title: method.title,
      queryParams: method.queryParams.map((item) => item.name),
      pathParams: method.pathParams.map((item) => item.name),
      formParams: method.formParams.map((item) => item.name),
      hasRequestBody: Boolean(method.requestBody),
      responsePreview: buildExampleForType(method.returnType, controller, simpleIndex, fqcnIndex)
    }));
    console.log(JSON.stringify({ controller: controllerPath, category: controller.categoryName, methodCount: methods.length, methods }, null, 2));
    return;
  }

  const config = loadConfig(args.config);
  for (const field of ["baseUrl", "token", "projectId"]) {
    if (!(field in config)) fail(`Missing config field: ${field}`);
  }
  const client = new YApiClient(String(config.baseUrl), String(config.token), Number(config.projectId));
  const catid = await client.ensureCategory(controller.categoryName);
  const existing = await client.listInterfaces();
  const existingMap = new Map(existing.map((item) => [`${String(item.method).toUpperCase()} ${item.path}`, item]));

  let created = 0;
  let updated = 0;
  const failures = [];
  for (const method of controller.methods) {
    const payload = buildMethodPayload(controller, method, catid, Number(config.projectId), String(config.token), simpleIndex, fqcnIndex);
    const key = `${method.httpMethod.toUpperCase()} ${method.fullPath}`;
    try {
      if (existingMap.has(key)) {
        const detail = await client.getInterface(Number(existingMap.get(key)._id));
        payload._id = detail._id || existingMap.get(key)._id;
        await client.saveInterface(payload);
        updated += 1;
      } else {
        await client.saveInterface(payload);
        created += 1;
      }
    } catch (error) {
      failures.push(`${method.httpMethod} ${method.fullPath}: ${error.message}`);
    }
  }

  console.log(JSON.stringify({ controller: controller.path, category: controller.categoryName, created, updated, failed: failures.length, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
