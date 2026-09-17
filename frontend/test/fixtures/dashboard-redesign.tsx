import { createRoot } from "react-dom/client";
import "../../src/theme/astryx.css";
import { DashboardPreview } from "../../src/design-preview/DashboardPreview";

createRoot(document.getElementById("root")!).render(<DashboardPreview />);
