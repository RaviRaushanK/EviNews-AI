module.exports = (sequelize, DataTypes) => {
  const Claim = sequelize.define('Claim', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the claim'
    },
    article_id: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Foreign key to articles.id'
    },
    event_id: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Foreign key to events.id (nullable — assigned after clustering)'
    },
    claim_text: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'The extracted claim statement'
    },
    claim_type: {
      type: DataTypes.ENUM('fact', 'opinion', 'quote', 'data'),
      allowNull: false,
      defaultValue: 'fact',
      comment: 'Classification of the claim'
    },
    confidence_score: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Confidence score (0.0 to 1.0) for the extraction'
    },
    extracted_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'When the claim was extracted'
    }
  }, {
    tableName: 'claims',
    timestamps: true,
    underscored: false,
    comment: 'Extracted claims from articles',
    indexes: [
      {
        name: 'idx_claims_article_id',
        fields: ['article_id']
      },
      {
        name: 'idx_claims_event_id',
        fields: ['event_id']
      },
      {
        name: 'idx_claims_claim_type',
        fields: ['claim_type']
      },
      {
        name: 'idx_claims_article_event',
        fields: ['article_id', 'event_id']
      }
    ],
    validate: {
      confidenceScoreInRange() {
        if (this.confidence_score !== null) {
          if (this.confidence_score < 0 || this.confidence_score > 1) {
            throw new Error('confidence_score must be between 0 and 1');
          }
        }
      }
    }
  });

  Claim.associate = (models) => {
    Claim.belongsTo(models.Article, {
      foreignKey: 'article_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
    Claim.belongsTo(models.Event, {
      foreignKey: 'event_id',
      onDelete: 'SET NULL',
      hooks: true
    });
    Claim.hasMany(models.ClaimEvidence, {
      foreignKey: 'claim_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
    Claim.hasMany(models.Contradiction, {
      foreignKey: 'claim_id_1',
      as: 'contradictionsAsFirst',
      onDelete: 'RESTRICT',
      hooks: true
    });
    Claim.hasMany(models.Contradiction, {
      foreignKey: 'claim_id_2',
      as: 'contradictionsAsSecond',
      onDelete: 'RESTRICT',
      hooks: true
    });
    Claim.belongsToMany(models.Summary, {
      through: models.SummaryClaim,
      foreignKey: 'claim_id',
      otherKey: 'summary_id'
    });
    Claim.hasMany(models.TimelineEvent, {
      foreignKey: 'claim_id',
      onDelete: 'SET NULL',
      hooks: true
    });
  };

  return Claim;
};