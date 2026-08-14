using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

internal static class GenerateFleetIcon
{
    private static readonly int[] Sizes = { 16, 20, 24, 32, 40, 48, 64, 128, 256 };

    private static void Main(string[] args)
    {
        if (args.Length < 1 || args.Length > 2) throw new ArgumentException("Pass the output .ico path and, optionally, a large .png path.");

        var images = new List<byte[]>();
        foreach (int size in Sizes) images.Add(Render(size));

        using (var stream = File.Create(args[0]))
        using (var writer = new BinaryWriter(stream))
        {
            writer.Write((ushort)0);
            writer.Write((ushort)1);
            writer.Write((ushort)images.Count);

            int offset = 6 + (16 * images.Count);
            for (int index = 0; index < images.Count; index++)
            {
                int size = Sizes[index];
                writer.Write((byte)(size == 256 ? 0 : size));
                writer.Write((byte)(size == 256 ? 0 : size));
                writer.Write((byte)0);
                writer.Write((byte)0);
                writer.Write((ushort)1);
                writer.Write((ushort)32);
                writer.Write((uint)images[index].Length);
                writer.Write((uint)offset);
                offset += images[index].Length;
            }

            foreach (byte[] image in images) writer.Write(image);
        }

        string pngPath = args.Length == 2 ? args[1] : Path.ChangeExtension(args[0], ".png");
        File.WriteAllBytes(pngPath, Render(1024));
    }

    private static byte[] Render(int size)
    {
        using (var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.Clear(Color.Transparent);

            float inset = Math.Max(0.6f, size * 0.035f);
            float diameter = size - (2 * inset);
            float radius = size * 0.235f;
            using (GraphicsPath shape = RoundedRectangle(inset, inset, diameter, diameter, radius))
            using (var fill = new LinearGradientBrush(
                new PointF(size * 0.15f, size * 0.05f),
                new PointF(size * 0.85f, size * 0.95f),
                Color.FromArgb(255, 113, 93, 233),
                Color.FromArgb(255, 91, 69, 211)))
            {
                graphics.FillPath(fill, shape);

                if (size >= 24)
                {
                    using (var highlight = new Pen(Color.FromArgb(72, 255, 255, 255), Math.Max(1f, size * 0.012f)))
                    {
                        graphics.DrawPath(highlight, shape);
                    }
                }
            }

            using (var mark = new SolidBrush(Color.White))
            {
                float left = size * 0.345f;
                float top = size * 0.245f;
                float stem = size * 0.105f;
                float cap = size * 0.315f;
                float bar = size * 0.095f;
                graphics.FillRectangle(mark, left, top, stem, size * 0.52f);
                graphics.FillRectangle(mark, left, top, cap, bar);
                graphics.FillRectangle(mark, left, top + size * 0.205f, size * 0.265f, bar);
            }

            using (var memory = new MemoryStream())
            {
                bitmap.Save(memory, ImageFormat.Png);
                return memory.ToArray();
            }
        }
    }

    private static GraphicsPath RoundedRectangle(float x, float y, float width, float height, float radius)
    {
        float arc = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(x, y, arc, arc, 180, 90);
        path.AddArc(x + width - arc, y, arc, arc, 270, 90);
        path.AddArc(x + width - arc, y + height - arc, arc, arc, 0, 90);
        path.AddArc(x, y + height - arc, arc, arc, 90, 90);
        path.CloseFigure();
        return path;
    }
}
