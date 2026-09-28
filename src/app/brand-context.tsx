"use client";

import { createContext, useContext } from "react";
import type { SiteBrand } from "@/lib/site-brand";

const BrandContext = createContext<SiteBrand>({ name: "Corner Ops", icon: "/corner-ops-icon.svg", teamHost: false });

export const BrandProvider = BrandContext.Provider;
export function useSiteBrand() { return useContext(BrandContext); }
