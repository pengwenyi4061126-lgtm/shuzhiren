import { controlPlaneConfig } from "@/lib/control-plane/config";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listAssets } from "@/lib/assets";
import { listProducts } from "@/lib/catalog";
import { createCreationProject, listCreationProjects, reviewCreationProjectScript } from "@/lib/creation-projects";
import { buildStudioDemoSeedInput, studioDemoProjectName } from "@/lib/shared/studio-demo-seed.mjs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    if (!controlPlaneConfig().demoMode) return Response.json({ error: "studio_demo_seed_disabled" }, { status: 404 });

    const existing = (await listCreationProjects(context)).find((project) => project.name === studioDemoProjectName);
    if (existing) {
      const reviewed = existing.scriptReview ? existing : await reviewCreationProjectScript(context, existing.id);
      if (!reviewed) return Response.json({ error: "studio_demo_seed_project_missing" }, { status: 404 });
      return Response.json({ data: reviewed, created: false });
    }

    const products = await listProducts(context);
    const selected = products.flatMap((product) => product.versions.map((version) => ({ product, version })))
      .find(({ version }) => version.status === "approved");
    if (!selected) return Response.json({ error: "studio_demo_seed_product_required" }, { status: 409 });

    const assets = await listAssets(context);
    const input = buildStudioDemoSeedInput({ product: selected.product, version: selected.version, assets });
    const project = await createCreationProject(context, input);
    const reviewed = await reviewCreationProjectScript(context, project.id);
    if (!reviewed) return Response.json({ error: "studio_demo_seed_review_failed" }, { status: 409 });
    return Response.json({ data: reviewed, created: true }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "studio_demo_seed_rejected" }, { status: error.status });
    throw error;
  }
}
