import { defineMeta } from "blume";

export default defineMeta({
  title: "Integrations",
  order: 4,
  display: "group",
  icon: "plug",
  pages: ["github", "slack", "webhooks", "email", "scim"],
});
