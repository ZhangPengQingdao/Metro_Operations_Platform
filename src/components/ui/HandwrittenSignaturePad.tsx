import React, { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Badge } from './Badge';

export interface HandwrittenSignaturePadProps {
  signerName?: string;
  submitting?: boolean;
  strokeColor?: string;
  strokeWidth?: number;
  transparentBackground?: boolean;
  onCancel?: () => void;
  onSubmit?: (blob: Blob, dataUrl: string) => Promise<void> | void;
  onChange?: (hasInk: boolean) => void;
  embedded?: boolean;
  showHeading?: boolean;
  showToolbar?: boolean;
  height?: string;
  className?: string;
}

export const HandwrittenSignaturePad: React.FC<HandwrittenSignaturePadProps> = ({
  signerName,
  submitting = false,
  strokeColor = '#0f172a',
  strokeWidth = 3,
  transparentBackground = true,
  onCancel,
  onSubmit,
  onChange,
  embedded = false,
  showHeading = true,
  showToolbar = true,
  height = '180px',
  className = ''
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [hasInk, setHasInk] = useState(false);
  const [currentStrokeColor, setCurrentStrokeColor] = useState(strokeColor);
  const [currentStrokeWidth, setCurrentStrokeWidth] = useState(strokeWidth);

  const prepareCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * ratio);
    canvas.height = Math.floor(rect.height * ratio);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (!transparentBackground) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, rect.width, rect.height);
    } else {
      ctx.clearRect(0, 0, rect.width, rect.height);
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = currentStrokeWidth;
    ctx.strokeStyle = currentStrokeColor;
  };

  useEffect(() => {
    prepareCanvas();
    const handleResize = () => {
      if (!hasInk) {
        prepareCanvas();
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [hasInk, currentStrokeColor, currentStrokeWidth, transparentBackground]);

  const getPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || submitting) return;

    const point = getPoint(event);
    drawingRef.current = true;
    canvas.setPointerCapture(event.pointerId);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || submitting) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    const point = getPoint(event);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    if (!hasInk) {
      setHasInk(true);
      onChange?.(true);
    }
  };

  const stopDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    canvasRef.current?.releasePointerCapture(event.pointerId);
  };

  const handleClear = () => {
    setHasInk(false);
    onChange?.(false);
    prepareCanvas();
  };

  const handleSubmit = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk || submitting) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height: imgHeight } = imageData;
    let minX = width;
    let minY = imgHeight;
    let maxX = 0;
    let maxY = 0;

    for (let y = 0; y < imgHeight; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const alpha = data[index + 3];
        if (alpha > 10) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    // Default bounds if not found
    if (minX > maxX) {
      minX = 0;
      maxX = width;
      minY = 0;
      maxY = imgHeight;
    }

    const padding = Math.round((window.devicePixelRatio || 1) * 16);
    const cropX = Math.max(0, minX - padding);
    const cropY = Math.max(0, minY - padding);
    const cropWidth = Math.min(width - cropX, maxX - minX + padding * 2);
    const cropHeight = Math.min(imgHeight - cropY, maxY - minY + padding * 2);

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = cropWidth;
    outputCanvas.height = cropHeight;

    const outputCtx = outputCanvas.getContext('2d');
    if (!outputCtx) return;

    if (!transparentBackground) {
      outputCtx.fillStyle = '#ffffff';
      outputCtx.fillRect(0, 0, cropWidth, cropHeight);
    }
    outputCtx.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const dataUrl = outputCanvas.toDataURL('image/png');
    const blob = await new Promise<Blob | null>((resolve) => outputCanvas.toBlob(resolve, 'image/png', 0.95));
    if (!blob) return;

    await onSubmit?.(blob, dataUrl);
  };

  return (
    <div className={`rounded-2xl border border-[#d0ded6] bg-white p-4 shadow-sm ${className}`}>
      {/* Header & Signer Info */}
      {showHeading && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge variant="success" size="sm">
              手写签名板
            </Badge>
            <div className="text-xs text-gray-700 font-semibold">
              {signerName ? `签署人：${signerName}` : '请在下方画板内完成手写签名'}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {showToolbar && (
              <div className="hidden sm:flex items-center gap-1.5 mr-2">
                <button
                  type="button"
                  onClick={() => setCurrentStrokeColor('#0f172a')}
                  className={`w-5 h-5 rounded-full border ${
                    currentStrokeColor === '#0f172a' ? 'ring-2 ring-emerald-500 scale-110' : 'opacity-60'
                  }`}
                  style={{ backgroundColor: '#0f172a' }}
                  title="碳黑墨汁"
                />
                <button
                  type="button"
                  onClick={() => setCurrentStrokeColor('#047857')}
                  className={`w-5 h-5 rounded-full border ${
                    currentStrokeColor === '#047857' ? 'ring-2 ring-emerald-500 scale-110' : 'opacity-60'
                  }`}
                  style={{ backgroundColor: '#047857' }}
                  title="运管松绿"
                />
                <button
                  type="button"
                  onClick={() => setCurrentStrokeColor('#1e40af')}
                  className={`w-5 h-5 rounded-full border ${
                    currentStrokeColor === '#1e40af' ? 'ring-2 ring-emerald-500 scale-110' : 'opacity-60'
                  }`}
                  style={{ backgroundColor: '#1e40af' }}
                  title="钢笔藏蓝"
                />
              </div>
            )}

            <Button
              variant="secondary"
              size="sm"
              disabled={submitting}
              onClick={handleClear}
            >
              清空重写
            </Button>
          </div>
        </div>
      )}

      {/* Canvas Drawing Area */}
      <div className="relative rounded-xl border border-dashed border-[#b8cdc1] bg-[#f8faf9] overflow-hidden">
        <canvas
          ref={canvasRef}
          style={{ height }}
          className="w-full touch-none cursor-crosshair bg-transparent"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDrawing}
          onPointerCancel={stopDrawing}
        />
        {!hasInk && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center text-xs text-gray-400 font-serif italic select-none">
            在此处使用鼠标、触控笔或触摸板手写签名
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="mt-3.5 flex items-center justify-end gap-2.5">
        {onCancel && (
          <Button
            variant="secondary"
            size="sm"
            disabled={submitting}
            onClick={onCancel}
          >
            取消
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={!hasInk || submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? '保存签字中...' : '确认并采集电子笔迹'}
        </Button>
      </div>
    </div>
  );
};
