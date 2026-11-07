const files:Record<string,string>={
  pepsi:"Pepsi_2023.svg",
  diet_pepsi:"Diet_Pepsi_2023.svg",
  cherry_pepsi:"Pepsi_wildcherry_brand_logo.png",
  mountain_dew:"Mountain_Dew_2025_logo.svg",
  diet_mountain_dew:"Diet_Mountain_Dew_logo.svg",
  code_red:"Mountain_Dew_Zero_Sugar_Code_Red_logo.svg",
  baja_blast:"Baja_Blast_logo.svg",
  starry:"Starry_logo.svg",
  brisk:"Brisk_logo.svg",
  root_beer:"Root_beer_mug.svg",
};
export async function GET(_:Request,{params}:{params:Promise<{brand:string}>}){const{brand}=await params,file=files[brand];if(!file)return new Response("Not found",{status:404});const source=`https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(file)}?width=512`,response=await fetch(source,{next:{revalidate:604800}});if(!response.ok)return new Response("Logo unavailable",{status:502});return new Response(await response.arrayBuffer(),{headers:{"content-type":response.headers.get("content-type")||"image/png","cache-control":"public, max-age=604800, stale-while-revalidate=2592000"}})}
