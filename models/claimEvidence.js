module.exports = (sequelize, DataTypes) => {
  const crypto = require('crypto');

  const ClaimEvidence = sequelize.define('ClaimEvidence', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the evidence link'
    },
    claim_id: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Foreign key to claims.id'
    },
    article_id: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Foreign key to articles.id'
    },
    evidence_text: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Supporting text snippet from the article (full text preserved)'
    },
    evidence_hash: {
      type: DataTypes.CHAR(64),
      allowNull: false,
      comment: 'SHA-256 of normalized evidence_text — used for duplicate-safe uniqueness without truncating text'
    },
    evidence_location: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Metadata to locate the snippet (e.g., paragraph index, section)'
    }
  }, {
    tableName: 'claim_evidence',
    timestamps: true,
    underscored: false,
    comment: 'Links claims to supporting evidence from articles',
    indexes: [
      {
        name: 'idx_claim_evidence_claim_id',
        fields: ['claim_id']
      },
      {
        name: 'idx_claim_evidence_article_id',
        fields: ['article_id']
      },
      {
        name: 'idx_claim_evidence_unique',
        fields: ['claim_id', 'article_id', 'evidence_hash'],
        unique: true
      }
    ],
    hooks: {
      beforeValidate: (instance) => {
        if (instance.evidence_text && !instance.evidence_hash) {
          const normalized = instance.evidence_text.trim().replace(/\s+/g, ' ');
          instance.evidence_hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
        }
      }
    }
  });

  ClaimEvidence.associate = (models) => {
    ClaimEvidence.belongsTo(models.Claim, {
      foreignKey: 'claim_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
    ClaimEvidence.belongsTo(models.Article, {
      foreignKey: 'article_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
  };

  return ClaimEvidence;
};