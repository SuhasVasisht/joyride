import matter from "gray-matter";
import YAML from "yaml";

export function parseFrontmatter(text: string) {
  const { data, content } = matter(text, { engines: { yaml: { parse: (s: string) => YAML.parse(s) ?? {}, stringify: (v: object) => YAML.stringify(v) } } });
  return { data, content };
}
