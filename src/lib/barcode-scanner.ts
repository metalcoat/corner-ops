export type ScannerCapture={value:string;durationMs:number};
export type ScannerDetectorOptions={maxInterKeyMs?:number;minLength?:number;maxDurationMs?:number};

export class KeyboardWedgeDetector {
  private value=""; private startedAt=0; private lastAt=0;
  constructor(private readonly emit:(capture:ScannerCapture)=>void,private readonly options:ScannerDetectorOptions={}){}
  reset(){this.value="";this.startedAt=0;this.lastAt=0}
  key(key:string,at=Date.now()):boolean{
    const maxGap=this.options.maxInterKeyMs??45,minLength=this.options.minLength??4,maxDuration=this.options.maxDurationMs??1000;
    if(key==="Enter"){
      const duration=this.startedAt?at-this.startedAt:0,scanned=this.value.length>=minLength&&duration<=maxDuration;
      const value=this.value;this.reset();if(scanned)this.emit({value,durationMs:duration});return scanned;
    }
    if(key.length!==1||key<"!"||key>"~"){this.reset();return false}
    if(this.lastAt&&at-this.lastAt>maxGap)this.reset();
    if(!this.startedAt)this.startedAt=at;this.value+=key;this.lastAt=at;return false;
  }
}

export function isHumanTextEntry(target:EventTarget|null):boolean{
  const element=target as HTMLElement|null;if(!element)return false;
  return element.isContentEditable||["INPUT","TEXTAREA","SELECT"].includes(element.tagName);
}
